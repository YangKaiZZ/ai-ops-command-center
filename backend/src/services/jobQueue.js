const pool = require('../config/db');

// A job queue in MySQL, for background work that must survive a restart
// (agent runs, stock re-reads from webhooks). A job is saved before the
// request that caused it is answered; the worker in this process claims
// queued jobs one at a time per slot, retries failures with backoff, and
// on start-up takes back jobs a previous process was running when it stopped.
//
// Assumes one backend process, like utils/lock.js: at start-up every job
// still marked "running" is treated as interrupted.

const handlers = new Map(); // type -> async (job) => void
const POLL_MS = 5000; // how often an idle slot looks for due retries (new jobs wake it at once)
const JOB_TIMEOUT_MS = 10 * 60 * 1000; // a job running longer than this counts as failed
const PRUNE_EVERY_MS = 60 * 60 * 1000;

function registerHandler(type, handler) {
  handlers.set(type, handler);
}

// Saves a job. With a dedupeKey, a second job with the same key is dropped
// (returns null), e.g. so one order gets one agent run however many times
// Shopify delivers it.
async function enqueue(type, sellerId, payload, { dedupeKey = null, maxAttempts = 3 } = {}) {
  try {
    const [result] = await pool.query(
      'INSERT INTO jobs (type, seller_id, payload, dedupe_key, max_attempts) VALUES (?, ?, ?, ?, ?)',
      [type, sellerId, JSON.stringify(payload), dedupeKey, maxAttempts]
    );
    wake();
    return result.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null;
    throw err;
  }
}

// Seconds to wait before retry number `attempt` (1-based): 30s, 2 min, 8 min...
// JOB_RETRY_BASE_SECONDS changes the base (the tests use 0).
function retryDelaySeconds(attempt) {
  const configured = process.env.JOB_RETRY_BASE_SECONDS;
  const base = configured?.trim() && Number(configured) >= 0 ? Number(configured) : 30;
  return base * 4 ** (attempt - 1);
}

// What a handler throws to run again in `seconds`, without it counting as a failed try.
function runAgainLater(seconds, reason) {
  return Object.assign(new Error(reason), { deferSeconds: seconds });
}

// Takes the oldest due job, marking it running, or returns null. SKIP LOCKED
// lets several slots claim at once without ever getting the same job.
async function claimNext() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, type, seller_id, payload, attempts, max_attempts FROM jobs
       WHERE status = 'queued' AND run_after <= NOW()
       ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    if (!rows.length) {
      await conn.commit();
      return null;
    }
    const job = rows[0];
    await conn.query("UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = NOW() WHERE id = ?", [job.id]);
    await conn.commit();
    return {
      id: job.id,
      type: job.type,
      sellerId: job.seller_id,
      payload: typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload,
      attempt: job.attempts + 1,
      maxAttempts: job.max_attempts,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runJob(job) {
  const tag = `[job ${job.id} ${job.type} seller=${job.sellerId} try ${job.attempt}/${job.maxAttempts}]`;
  try {
    const handler = handlers.get(job.type);
    if (!handler) throw Object.assign(new Error(`no handler for job type "${job.type}"`), { retryable: false });
    await withTimeout(handler(job), JOB_TIMEOUT_MS);
    await pool.query("UPDATE jobs SET status = 'done', locked_at = NULL, finished_at = NOW() WHERE id = ?", [job.id]);
  } catch (err) {
    // Not a failure: the handler asked to run again later (runAgainLater), e.g.
    // while Shopify's fraud analysis is pending. It doesn't use up a try.
    if (err.deferSeconds > 0) {
      await pool.query(
        "UPDATE jobs SET status = 'queued', attempts = attempts - 1, locked_at = NULL, run_after = NOW() + INTERVAL ? SECOND WHERE id = ?",
        [err.deferSeconds, job.id]
      );
      console.log(`${tag} ${err.message}; running it again in ${err.deferSeconds}s`);
      return;
    }
    // An error marked retryable: false (e.g. no API key) won't get better by waiting.
    const giveUp = err.retryable === false || job.attempt >= job.maxAttempts;
    const message = String(err.message || err).slice(0, 1000);
    if (giveUp) {
      await pool.query(
        "UPDATE jobs SET status = 'failed', locked_at = NULL, finished_at = NOW(), last_error = ? WHERE id = ?",
        [message, job.id]
      );
      console.error(`${tag} failed for good: ${message}`);
    } else {
      const delay = retryDelaySeconds(job.attempt);
      await pool.query(
        "UPDATE jobs SET status = 'queued', locked_at = NULL, last_error = ?, run_after = NOW() + INTERVAL ? SECOND WHERE id = ?",
        [message, delay, job.id]
      );
      console.warn(`${tag} failed, retrying in ${delay}s: ${message}`);
    }
  }
}

// Jobs still marked running belong to a process that stopped mid-job.
async function requeueInterrupted() {
  const [result] = await pool.query(
    `UPDATE jobs SET
       status = IF(attempts >= max_attempts, 'failed', 'queued'),
       finished_at = IF(attempts >= max_attempts, NOW(), NULL),
       locked_at = NULL,
       last_error = 'interrupted by a restart'
     WHERE status = 'running'`
  );
  return result.affectedRows;
}

// Housekeeping, hourly: finished jobs, old webhook ids and counters for
// limits whose windows are long past aren't needed.
async function pruneOldRows() {
  await pool.query("DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < NOW() - INTERVAL 30 DAY");
  await pool.query('DELETE FROM webhook_deliveries WHERE received_at < NOW() - INTERVAL 7 DAY');
  await pool.query('DELETE FROM agent_runs WHERE started_at < NOW() - INTERVAL 7 DAY');
  await pool.query('DELETE FROM rate_limit_events WHERE created_at < NOW() - INTERVAL 1 DAY');
  await pool.query('DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL 1 DAY');
}

// --- the worker ---
let worker = null;
const wakeWaiters = new Set(); // idle slots, woken early when a job is added

function wake() {
  for (const done of [...wakeWaiters]) done();
}

function waitForWork(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeWaiters.add(done);
  });
}

async function slotLoop(state) {
  while (!state.stopping) {
    let job = null;
    try {
      job = await claimNext();
    } catch (err) {
      console.error(`[jobs] could not claim a job: ${err.message}`);
    }
    if (job) await runJob(job);
    else if (!state.stopping) await waitForWork(POLL_MS);
  }
}

// Starts `concurrency` slots (JOB_CONCURRENCY, default 2).
async function startWorker({ concurrency } = {}) {
  if (worker) return;
  const slots = concurrency || Math.max(1, Number(process.env.JOB_CONCURRENCY) || 2);
  const state = { stopping: false };
  worker = state;
  const taken = await requeueInterrupted();
  if (taken) console.log(`[jobs] ${taken} job(s) interrupted by the last restart are queued again`);
  state.loops = Array.from({ length: slots }, () => slotLoop(state));
  state.pruneTimer = setInterval(() => pruneOldRows().catch((err) => console.error(`[jobs] prune failed: ${err.message}`)), PRUNE_EVERY_MS);
  console.log(`[jobs] worker started (${slots} at a time)`);
}

// Stops claiming, and waits up to timeoutMs for running jobs to finish.
// Anything still running then is taken back at the next start.
async function stopWorker(timeoutMs = 25000) {
  if (!worker) return true;
  const state = worker;
  state.stopping = true;
  clearInterval(state.pruneTimer);
  wake();
  let timer;
  const finished = await Promise.race([
    Promise.all(state.loops).then(() => true),
    new Promise((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
  ]);
  clearTimeout(timer);
  worker = null;
  return finished;
}

module.exports = { registerHandler, enqueue, startWorker, stopWorker, retryDelaySeconds, runAgainLater, requeueInterrupted, pruneOldRows };
