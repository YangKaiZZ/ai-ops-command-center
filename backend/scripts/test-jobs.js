// End-to-end check of the job queue, run in-process against a fake DeepSeek
// on localhost (no real LLM call; the real database is used with a
// throwaway seller and store):
//   1. jobs: success, retry after failures, give up (retryable or not), one job per dedupe key
//   2. restarts: jobs a stopped process was running are queued again (or failed if out of tries)
//   3. shutdown: stopping waits for a running job; one cut off runs again at the next start
//   4. webhooks: a signed orders/create queues one agent run, which saves the decision;
//      the same delivery again is a duplicate (remembered in the database), and the
//      same order under a new delivery id doesn't run the agent twice
//   5. inventory_levels/update queues a stock re-read that runs in the worker
//
// Usage:  npm run test:jobs
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const http = require('http');
const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(100);
  }
  return null;
}

// --- a fake DeepSeek: HOLD for orders, RESTOCK otherwise, never a tool call ---
function startFakeLLM() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push(body);
      const content = body.includes('A new order was just placed') ? 'HOLD - fake agent reply' : 'RESTOCK - fake agent reply';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-chat',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

async function main() {
  const llm = await startFakeLLM();
  const webhookSecret = 'jobs-test-secret';
  // Set before anything loads the .env (real environment variables win over
  // it), so the real DeepSeek key and endpoint can't be used by accident.
  Object.assign(process.env, {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.port}`,
    SHOPIFY_API_SECRET: webhookSecret,
    JOB_RETRY_BASE_SECONDS: '0',
    AGENT_DAILY_LIMIT_PER_ACCOUNT: '1000',
    AGENT_DAILY_LIMIT_TOTAL: '100000',
  });
  require('dotenv').config({ quiet: true });
  process.env.MCP_SERVER_PATH ||= path.join(__dirname, '..', '..', 'mcp', 'server.js');

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const queue = require('../src/services/jobQueue');
  require('../src/services/jobHandlers');

  // The worker takes any due job. Don't run it next to real work in this database.
  const [[others]] = await pool.query("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')");
  if (Number(others.n) > 0) {
    throw new Error(`${others.n} job(s) are queued or running in this database; run this test when the queue is empty`);
  }

  const shop = `jobs-test-${Date.now()}.myshopify.com`;
  const [created] = await pool.query(
    "INSERT INTO sellers (business_name, email, password_hash, shopify_shop_domain) VALUES ('Job queue test', ?, 'not-a-real-hash', ?)",
    [`jobs-test-${Date.now()}@example.test`, shop]
  );
  const sellerId = created.insertId;
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const jobRow = async (id) => (await pool.query('SELECT status, attempts, last_error FROM jobs WHERE id = ?', [id]))[0][0];
  const settled = (id) => until(async () => {
    const row = await jobRow(id);
    return row && ['done', 'failed'].includes(row.status) ? row : null;
  });
  const webhookIds = [];

  async function sendWebhook(route, topic, body, webhookId) {
    webhookIds.push(webhookId);
    const raw = JSON.stringify(body);
    const res = await fetch(`${base}/api/webhooks/${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': topic,
        'X-Shopify-Shop-Domain': shop,
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', webhookSecret).update(raw).digest('base64'),
      },
      body: raw,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  // Test-only job types.
  let flakyCalls = 0;
  queue.registerHandler('test_ok', async () => {});
  queue.registerHandler('test_flaky', async () => {
    if (++flakyCalls < 3) throw new Error(`flaky failure ${flakyCalls}`);
  });
  queue.registerHandler('test_fatal', async () => {
    throw Object.assign(new Error('not worth retrying'), { retryable: false });
  });
  queue.registerHandler('test_broken', async () => {
    throw new Error('always fails');
  });
  queue.registerHandler('test_slow', () => wait(1500));

  try {
    await queue.startWorker({ concurrency: 2 });

    console.log('\n1. Jobs');
    const ok = await queue.enqueue('test_ok', sellerId, {});
    const flaky = await queue.enqueue('test_flaky', sellerId, {});
    const fatal = await queue.enqueue('test_fatal', sellerId, {});
    const broken = await queue.enqueue('test_broken', sellerId, {}, { maxAttempts: 2 });
    let row = await settled(ok);
    check(row?.status === 'done' && row.attempts === 1, 'a job that works is done after one try', JSON.stringify(row));
    row = await settled(flaky);
    check(row?.status === 'done' && row.attempts === 3, 'a job that fails twice is retried and then done', JSON.stringify(row));
    row = await settled(fatal);
    check(row?.status === 'failed' && row.attempts === 1, 'an error marked not retryable fails at once', JSON.stringify(row));
    row = await settled(broken);
    check(row?.status === 'failed' && row.attempts === 2 && row.last_error === 'always fails', 'a job out of tries fails with its last error', JSON.stringify(row));
    const first = await queue.enqueue('test_ok', sellerId, {}, { dedupeKey: `test:${sellerId}:once` });
    const second = await queue.enqueue('test_ok', sellerId, {}, { dedupeKey: `test:${sellerId}:once` });
    check(first && second === null, 'a second job with the same dedupe key is dropped');

    console.log('\n2. Restarts');
    await queue.stopWorker();
    const [cut] = await pool.query(
      "INSERT INTO jobs (type, seller_id, payload, status, attempts, max_attempts, locked_at) VALUES ('test_ok', ?, '{}', 'running', 1, 3, NOW())",
      [sellerId]
    );
    const [spent] = await pool.query(
      "INSERT INTO jobs (type, seller_id, payload, status, attempts, max_attempts, locked_at) VALUES ('test_ok', ?, '{}', 'running', 3, 3, NOW())",
      [sellerId]
    );
    await queue.startWorker({ concurrency: 2 });
    row = await settled(cut.insertId);
    check(row?.status === 'done' && row.attempts === 2, 'a job cut off mid-run is run again after a restart', JSON.stringify(row));
    row = await settled(spent.insertId);
    check(row?.status === 'failed' && row.last_error === 'interrupted by a restart', 'one that had no tries left is marked failed', JSON.stringify(row));

    console.log('\n3. Shutdown');
    const slow = await queue.enqueue('test_slow', sellerId, {});
    await until(async () => (await jobRow(slow))?.status === 'running');
    const finished = await queue.stopWorker(5000);
    check(finished && (await jobRow(slow)).status === 'done', 'stopping waits for a running job to finish');
    await queue.startWorker({ concurrency: 2 });
    const cutOff = await queue.enqueue('test_slow', sellerId, {});
    await until(async () => (await jobRow(cutOff))?.status === 'running');
    const finishedInTime = await queue.stopWorker(100);
    check(!finishedInTime && (await jobRow(cutOff)).status === 'running', 'a job still running at the deadline is left marked running');
    await wait(1600); // let the old slot finish its handler, as a killed process wouldn't
    await pool.query("UPDATE jobs SET status = 'running', finished_at = NULL WHERE id = ?", [cutOff]); // ...and put back what a kill leaves
    await queue.startWorker({ concurrency: 2 });
    row = await settled(cutOff);
    check(row?.status === 'done' && row.attempts === 2, 'the next start runs it again', JSON.stringify(row));

    console.log('\n4. Order webhooks');
    const order = {
      id: Number(`9${Date.now()}`.slice(0, 15)),
      name: '#JOBS-1',
      financial_status: 'paid',
      total_price: '12.00',
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'), // Shopify's format
      customer: { first_name: 'Test', last_name: 'Buyer' },
      line_items: [{ variant_id: 123456789, title: 'Test Mug', quantity: 1 }],
    };
    const deliveryId = crypto.randomUUID();
    const firstDelivery = await sendWebhook('orders-create', 'orders/create', order, deliveryId);
    check(firstDelivery.status === 200, 'orders/create answered 200', JSON.stringify(firstDelivery.body));
    const agentJobs = async () =>
      (await pool.query("SELECT id, status, payload FROM jobs WHERE seller_id = ? AND type = 'agent_run'", [sellerId]))[0];
    const [agentJob] = await agentJobs();
    const payload = typeof agentJob?.payload === 'string' ? JSON.parse(agentJob.payload) : agentJob?.payload;
    check(Boolean(agentJob), 'one agent run was queued before the reply');
    check(payload && !JSON.stringify(payload).includes('Buyer'), "the queued job doesn't hold the customer's name");
    const decision = await until(async () => {
      const [rows] = await pool.query('SELECT action_taken, order_id FROM decisions WHERE seller_id = ?', [sellerId]);
      return rows[0];
    });
    check(decision?.action_taken === 'hold' && decision.order_id != null, "the worker ran the agent and saved its decision for the order", JSON.stringify(decision));
    check(Boolean(agentJob) && (await settled(agentJob.id))?.status === 'done', 'the agent job is done');

    const again = await sendWebhook('orders-create', 'orders/create', order, deliveryId);
    check(again.status === 200 && again.body.duplicate === true, 'the same delivery again is recognised as a duplicate');
    const [[remembered]] = await pool.query('SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id = ?', [deliveryId]);
    check(Number(remembered.n) === 1, 'the delivery id is kept in the database, so it survives a restart');
    const redelivered = await sendWebhook('orders-create', 'orders/create', order, crypto.randomUUID());
    check(redelivered.status === 200 && (await agentJobs()).length === 1, 'the same order under a new delivery id does not queue a second agent run');
    const llmCallsBefore = llm.requests.length;
    await wait(500);
    const [decisions] = await pool.query('SELECT id FROM decisions WHERE seller_id = ?', [sellerId]);
    check(decisions.length === 1 && llm.requests.length === llmCallsBefore, 'still one decision and no extra model call');

    console.log('\n5. Inventory webhooks');
    const inv = await sendWebhook('inventory-levels-update', 'inventory_levels/update', { inventory_item_id: 424242, available: 3 }, crypto.randomUUID());
    check(inv.status === 200, 'inventory_levels/update answered 200');
    const [[refreshJob]] = await pool.query(
      "SELECT id FROM jobs WHERE seller_id = ? AND type = 'refresh_inventory_item'",
      [sellerId]
    );
    check((await settled(refreshJob?.id))?.status === 'done', 'its stock re-read ran in the worker');
  } finally {
    await queue.stopWorker(5000);
    server.close();
    await pool.query('DELETE FROM decisions WHERE seller_id = ?', [sellerId]);
    await pool.query('DELETE FROM orders WHERE seller_id = ?', [sellerId]);
    await pool.query('DELETE FROM sellers WHERE id = ?', [sellerId]); // its jobs and agent_runs go with it
    if (webhookIds.length) await pool.query('DELETE FROM webhook_deliveries WHERE webhook_id IN (?)', [webhookIds]);
    llm.server.close();
    await pool.end();
  }
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.stack || err.message}`);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
  });
