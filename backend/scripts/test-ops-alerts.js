// End-to-end check of the alerts to whoever runs the server (opsAlerts.js),
// run in-process; sends are captured, nothing leaves this machine. The real
// database is used with throwaway sellers, removed at the end:
//   1. an alert goes to the email and Telegram chat set; the same kind again
//      within its window is only logged; with neither set, nothing is sent
//   2. a job that fails for good; a store whose sync fails 3 times in a row
//      (once, reset by a success); a store disconnected by a refused token
//      refresh; a webhook that fails; the agent's total daily cap
//   3. /api/health checks the database
//
// Usage:  npm run test:ops-alerts
const path = require('path');
process.chdir(path.join(__dirname, '..'));

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

async function main() {
  // Set before anything loads the .env (real environment variables win over it).
  Object.assign(process.env, {
    OPS_ALERT_EMAIL: 'ops@example.test',
    OPS_ALERT_TELEGRAM_CHAT_ID: '424242',
    SMTP_URL: 'smtp://127.0.0.1:1',
    EMAIL_FROM: 'Arbiter Ops <alerts@example.test>',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    SHOPIFY_API_SECRET: 'ops-test-secret',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: 'http://127.0.0.1:9', // never reached: the cap stops the run first
    AGENT_DAILY_LIMIT_TOTAL: '0',
    JOB_RETRY_BASE_SECONDS: '0',
  });
  require('dotenv').config({ quiet: true });

  // Captured, never sent.
  const sent = [];
  const email = require('../src/services/email');
  const telegram = require('../src/services/telegram');
  email.sendEmail = async (message) => sent.push({ via: 'email', to: message.to, subject: message.subject, text: message.text });
  telegram.sendTelegramMessage = async (chatId, text) => sent.push({ via: 'telegram', to: chatId, text });

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const ops = require('../src/services/opsAlerts');
  const queue = require('../src/services/jobQueue');
  const oauth = require('../src/services/shopifyOAuth');
  const sellers = require('../src/models/sellerModel');
  const { encryptSecret } = require('../src/config/secrets');
  const { runAgent } = require('../src/services/agentService');

  const startedAt = new Date(Date.now() - 1000);
  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];
  const addSeller = async (name, extra = {}) => {
    const [r] = await pool.query('INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, ?)', [name, `ops-${run}-${name}@example.test`, 'x']);
    sellerIds.push(r.insertId);
    if (Object.keys(extra).length) await pool.query('UPDATE sellers SET ? WHERE id = ?', [extra, r.insertId]);
    return r.insertId;
  };
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const since = (n) => sent.slice(n);
  const key = (label) => `${label}-${run}`; // this run's own alert kinds

  try {
    console.log('\n1. Sending');
    let before = sent.length;
    check((await ops.notifyOps(key('first'), 'Something broke.\nDetails here.')) === true, 'an alert is sent');
    const [first, second] = since(before);
    check(
      first?.via === 'telegram' && first.to === '424242' && first.text.startsWith('Arbiter Ops server: Something broke.\nDetails here.'),
      'to the Telegram chat',
      JSON.stringify(first)
    );
    check(second?.via === 'email' && second.to === 'ops@example.test' && second.subject === 'Arbiter Ops server: Something broke.', 'and the email address', JSON.stringify(second));
    before = sent.length;
    check((await ops.notifyOps(key('first'), 'Something broke again.')) === false && sent.length === before, 'the same kind again within its window: only logged');
    check((await ops.notifyOps(key('other'), 'Something else.')) === true, 'another kind goes out');
    const saved = process.env.OPS_ALERT_EMAIL;
    const savedChat = process.env.OPS_ALERT_TELEGRAM_CHAT_ID;
    delete process.env.OPS_ALERT_EMAIL;
    delete process.env.OPS_ALERT_TELEGRAM_CHAT_ID;
    before = sent.length;
    check((await ops.notifyOps(key('unset'), 'Nobody to tell.')) === false && sent.length === before && !ops.isConfigured(), 'with nothing set, nothing is sent');
    process.env.OPS_ALERT_EMAIL = saved;
    process.env.OPS_ALERT_TELEGRAM_CHAT_ID = savedChat;
    delete process.env.TELEGRAM_BOT_TOKEN;
    before = sent.length;
    await ops.notifyOps(key('email-only'), 'Only email.');
    check(since(before).length === 1 && since(before)[0].via === 'email', 'no bot token: email only');
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';

    console.log('\n2. What triggers one');
    const seller = await addSeller('main');

    const [[busy]] = await pool.query("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')");
    if (Number(busy.n) > 0) {
      check(false, `the job queue is empty (${busy.n} job(s) queued or running; run this test when it's empty)`);
    } else {
      const jobType = `ops_test_${run}`;
      queue.registerHandler(jobType, async () => {
        throw new Error('the thing it needed is gone');
      });
      before = sent.length;
      const jobId = await queue.enqueue(jobType, seller, {}, { maxAttempts: 2 });
      await queue.startWorker({ concurrency: 1 });
      await until(async () => (await pool.query('SELECT status FROM jobs WHERE id = ?', [jobId]))[0][0]?.status === 'failed');
      await until(async () => since(before).length >= 2, 3000);
      await queue.stopWorker(5000);
      const jobAlerts = since(before).filter((m) => m.via === 'telegram');
      check(
        jobAlerts.length === 1 && jobAlerts[0].text.includes(`A ${jobType} job failed for good (job ${jobId}, seller ${seller}, try 2 of 2).\nthe thing it needed is gone`),
        'a job that failed for good: one alert, after its last try',
        JSON.stringify(jobAlerts.map((m) => m.text.split('\n').slice(0, 2)))
      );
    }

    const syncSeller = await addSeller('sync');
    before = sent.length;
    await ops.recordSyncResult(syncSeller, ['orders FAILED (503)']);
    await ops.recordSyncResult(syncSeller, ['orders FAILED (503)']);
    check(since(before).length === 0, 'a store failing its sync twice: no alert yet');
    await ops.recordSyncResult(syncSeller, ['orders FAILED (503)', 'inventory FAILED (503)']);
    const syncAlert = since(before).find((m) => m.via === 'telegram');
    check(syncAlert?.text.includes(`Seller ${syncSeller}'s store sync failed 3 times in a row.\norders FAILED (503)\ninventory FAILED (503)`), 'the third in a row: alert', syncAlert?.text.split('\n')[0]);
    before = sent.length;
    await ops.recordSyncResult(syncSeller, ['orders FAILED (503)']);
    await ops.recordSyncResult(syncSeller, []);
    for (let i = 0; i < 2; i++) await ops.recordSyncResult(syncSeller, ['orders FAILED (503)']);
    check(since(before).length === 0, 'a fourth is not alerted again; a success starts the count over');

    const refreshed = await addSeller('refresh', {
      shopify_shop_domain: `ops-${run}.myshopify.com`,
      shopify_access_token: encryptSecret('old-token'),
      shopify_refresh_token: encryptSecret('old-refresh'),
      shopify_token_expires_at: new Date(Date.now() - 60 * 1000),
    });
    oauth.refreshAccessToken = async () => {
      throw Object.assign(new Error('refresh rejected'), { response: { status: 401 } });
    };
    before = sent.length;
    const creds = await sellers.getStoreCredentials(refreshed);
    const refreshAlert = since(before).find((m) => m.via === 'telegram');
    check(
      creds === null && refreshAlert?.text.includes(`Seller ${refreshed}'s store (ops-${run}.myshopify.com) was disconnected: Shopify refused to refresh its token (HTTP 401).`),
      'a store disconnected by a refused token refresh: alert',
      refreshAlert?.text.split('\n')[0]
    );

    const hookSeller = await addSeller('hook', { shopify_shop_domain: `ops-${run}-hook.myshopify.com` });
    const raw = JSON.stringify({ id: null, name: '#bad' }); // no order id: saving it fails
    before = sent.length;
    const res = await fetch(`${base}/api/webhooks/orders-updated`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', 'ops-test-secret').update(raw).digest('base64'),
        'X-Shopify-Shop-Domain': `ops-${run}-hook.myshopify.com`,
        'X-Shopify-Webhook-Id': crypto.randomUUID(),
      },
      body: raw,
    });
    await until(async () => since(before).length > 0, 3000);
    const hookAlert = since(before).find((m) => m.via === 'telegram');
    check(res.status === 500 && hookAlert?.text.includes('A orders/updated webhook failed (Shopify will retry it).'), 'a webhook that fails: 500 for Shopify, and an alert', `HTTP ${res.status}`);
    check(hookSeller > 0, 'for a known store');

    // Only if this kind hasn't been alerted in the last 12 hours on this database.
    const capLimit = { bucket: 'ops-alert', windowSeconds: 12 * 60 * 60, max: 1 };
    const capAlreadySent = await require('../src/services/rateLimit').secondsUntilAllowed(capLimit, 'agent-total-cap');
    before = sent.length;
    const result = await runAgent(seller, { type: 'low_stock_crossed', items: [{ item_name: 'Mug', shopify_variant_id: '1', previous_stock: 9, current_stock: 2, low_stock_threshold: 5 }] });
    const capAlert = since(before).find((m) => m.via === 'telegram');
    if (capAlreadySent) {
      check(result === null && !capAlert, "the agent's total cap: skipped; already alerted recently, so not again");
    } else {
      check(result === null && capAlert?.text.includes("The agent's daily limit for all accounts (AGENT_DAILY_LIMIT_TOTAL) is used up"), "the agent's total cap: skipped, and an alert");
    }

    console.log('\n3. Health');
    const health = await fetch(`${base}/api/health`);
    check(health.status === 200 && (await health.json()).status === 'ok', '/api/health checks the database: ok');
  } finally {
    await queue.stopWorker(5000);
    server.close();
    await pool.query("DELETE FROM rate_limit_events WHERE bucket = 'ops-alert' AND created_at >= ?", [startedAt]);
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]); // jobs and agent runs go with them
    }
    console.log('\nRemoved the test sellers, their jobs and this run\'s alert counts.');
    await pool.end();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exitCode = failures ? 1 : 0;
  })
  .catch((err) => {
    console.error('\nERROR:', err);
    process.exitCode = 1;
  });
