const pool = require('../config/db');
const { withLock } = require('../utils/lock');

// Daily caps on agent runs, so one busy (or abusive) account, or many new
// ones, can't run up the LLM bill. Each run makes at most MAX_STEPS model
// calls (agentService). Runs are counted over the last 24 hours.
const DEFAULTS = { perAccount: 50, total: 200 };

// A blank or invalid value means the default; 0 stops the agent entirely.
function readLimit(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function limits() {
  return {
    perAccount: readLimit('AGENT_DAILY_LIMIT_PER_ACCOUNT', DEFAULTS.perAccount),
    total: readLimit('AGENT_DAILY_LIMIT_TOTAL', DEFAULTS.total),
  };
}

// Which cap one more run would break: 'account', 'total', or null (go ahead).
function overLimit({ accountRuns, totalRuns }, { perAccount, total }) {
  if (accountRuns >= perAccount) return 'account';
  if (totalRuns >= total) return 'total';
  return null;
}

// Counts this seller's run if both caps allow it. Returns null when the run
// may go ahead, or which cap it hit. One check at a time, so two events
// arriving together can't both take the last run.
function claimRun(sellerId) {
  return withLock('agent-budget', async () => {
    const [[counts]] = await pool.query(
      `SELECT COALESCE(SUM(seller_id = ?), 0) AS accountRuns, COUNT(*) AS totalRuns
       FROM agent_runs WHERE started_at > NOW() - INTERVAL 1 DAY`,
      [sellerId]
    );
    const hit = overLimit({ accountRuns: Number(counts.accountRuns), totalRuns: Number(counts.totalRuns) }, limits());
    if (!hit) await pool.query('INSERT INTO agent_runs (seller_id) VALUES (?)', [sellerId]);
    return hit;
  });
}

// The decision saved instead of the agent's reply. Line 1 starts with
// SKIPPED, which the dashboard shows as its own verdict.
function skippedReasoning(hit, trigger, { perAccount } = limits()) {
  const what = trigger.type === 'order_created' ? `order ${trigger.order.name}` : 'low-stock change';
  if (hit === 'account') {
    return `SKIPPED - daily limit reached\nThis account has used its ${perAccount} agent checks for the last 24 hours, so this ${what} wasn't checked. Checks free up again as older ones pass the 24-hour mark.`;
  }
  return `SKIPPED - agent busy\nThe service's daily limit of agent checks is used up, so this ${what} wasn't checked. Checks free up again within 24 hours.`;
}

module.exports = { claimRun, limits, overLimit, readLimit, skippedReasoning, DEFAULTS };
