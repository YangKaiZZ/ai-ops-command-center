// End-to-end check of risk triage, run in-process against a fake DeepSeek on
// localhost and a fake Shopify fraud analysis (shopifyService.fetchOrderRisks);
// alerts are captured instead of sent. The real database is used with
// throwaway sellers, removed at the end:
//   1. an order's run reads Shopify's fraud check and saves it on the order;
//      high risk (or "cancel") is HOLD even when the model says FULFILL;
//      medium risk and addresses that don't match are the model's call
//   2. a pending check: a new order's run comes back later (no model call, no
//      run counted); an older one decides without it; Shopify down: decides
//      without it too, and says why
//   3. through the job queue: the deferred run waits without using a try, then
//      runs once the check is in
//   4. the order sync reads it again for open orders from the last week and
//      alerts once, only when risk went up after the agent had decided
//   5. the API: `risk` on orders, ?risk=flagged, and the order page reads the
//      check of an order that never had one
//   6. privacy: data requests include it; a redact removes its reasons
//
// Usage:  npm run test:risk
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

// --- a fake DeepSeek: answers `reply.text`, never a tool call ---
const reply = { text: 'FULFILL - looks fine\n- every item ships' };
function startFakeLLM() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake-completion',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-chat',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply.text } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

// The fraud_check the agent was given in a request, or undefined.
function fraudCheckSent(request) {
  const text = request?.messages?.[1]?.content || '';
  const start = text.indexOf('{');
  try {
    return JSON.parse(text.slice(start, text.indexOf('\n}', start) + 2)).fraud_check;
  } catch {
    return undefined;
  }
}

// An order in Shopify's GraphQL shape, as fetchOrderRisks returns it.
const riskNode = (id, level, { recommendation = 'NONE', reasons = [], matches = true } = {}) => ({
  id: `gid://shopify/Order/${id}`,
  requiresShipping: true,
  billingAddressMatchesShippingAddress: matches,
  risk: {
    recommendation,
    assessments: level ? [{ riskLevel: level, facts: reasons.map((description) => ({ description, sentiment: 'NEGATIVE' })) }] : [],
  },
});

// A time Shopify-style (MySQL rejects a bare Z), `msAgo` before now.
const shopifyTime = (msAgo) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const shopifyOrder = (id, msAgo = 0) => ({
  id,
  name: `#${id}`,
  created_at: shopifyTime(msAgo),
  fulfillment_status: null,
  financial_status: 'paid',
  customer: { first_name: 'Ana', last_name: 'Smith' },
  total_price: '50.00',
  line_items: [{ id: id * 10, variant_id: null, title: 'Gift wrap', quantity: 1, price: '50.00' }], // custom item: no stock call
});

async function main() {
  const llm = await startFakeLLM();
  // Set before anything loads the .env: real environment variables win over
  // it, so the real DeepSeek key and endpoint can't be used by accident.
  Object.assign(process.env, {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.port}`,
    AGENT_DAILY_LIMIT_PER_ACCOUNT: '100',
    AGENT_DAILY_LIMIT_TOTAL: '100000',
    DASHBOARD_URL: 'https://dash.example.test',
  });
  require('dotenv').config({ quiet: true });
  process.env.MCP_SERVER_PATH ||= path.join(__dirname, '..', '..', 'mcp', 'server.js');

  // Alerts are captured. Replaced before anything takes postDecision from the module.
  const alerts = [];
  const notifier = require('../src/services/notifier');
  notifier.postDecision = async (sellerId, text, options = {}) => (alerts.push({ sellerId, text, ...options }), []);

  // The fake Shopify: fraud analysis by order id, and who asked.
  const shopifyService = require('../src/services/shopifyService');
  const risks = new Map();
  const riskCalls = [];
  let risksFail = false;
  shopifyService.fetchOrderRisks = async (shopDomain, accessToken, ids) => {
    riskCalls.push(ids.map(String));
    if (risksFail) throw new Error('socket hang up');
    return new Map(ids.filter((id) => risks.has(String(id))).map((id) => [String(id), risks.get(String(id))]));
  };
  shopifyService.fetchOrders = async () => [];
  shopifyService.fetchOrdersByIds = async () => [];

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET, encryptSecret } = require('../src/config/secrets');
  const { upsertOrder } = require('../src/models/orderModel');
  const { runAgent, queueAgentRun } = require('../src/services/agentService');
  const { syncOrders } = require('../src/services/syncService');
  const privacy = require('../src/models/privacyModel');
  const queue = require('../src/services/jobQueue');
  require('../src/services/jobHandlers');

  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];
  const addSeller = async (name) => {
    const [r] = await pool.query(
      "INSERT INTO sellers (business_name, email, password_hash, shopify_shop_domain, shopify_access_token) VALUES (?, ?, 'x', ?, ?)",
      [name, `risk-${run}-${name}@example.test`, `risk-${run}-${name}.myshopify.com`, encryptSecret('shpat_fake_token')]
    );
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  const orderRow = async (sellerId, shopifyId) =>
    (await pool.query('SELECT * FROM orders WHERE seller_id = ? AND shopify_order_id = ?', [sellerId, String(shopifyId)]))[0][0];
  const decisionFor = async (sellerId, number) =>
    (await pool.query('SELECT action_taken, reasoning FROM decisions WHERE seller_id = ? AND order_number = ? ORDER BY id DESC', [sellerId, number]))[0][0];
  const runsFor = async (sellerId) => Number((await pool.query('SELECT COUNT(*) AS n FROM agent_runs WHERE seller_id = ?', [sellerId]))[0][0].n);
  // A webhook's work: store the order, then run the agent on it.
  const newOrder = async (sellerId, order) => {
    await upsertOrder(sellerId, order);
    return runAgent(sellerId, { type: 'order_created', order });
  };

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const get = async (route, sellerId) => {
    const token = jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' });
    const res = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    const seller = await addSeller('main');

    console.log("\n1. An order's run reads the fraud check");
    risks.set('7001', riskNode(7001, 'HIGH', { recommendation: 'CANCEL', reasons: ['Card declined 4 times', 'Paid with a prepaid card'], matches: false }));
    reply.text = 'FULFILL - looks fine\n- every item ships';
    await newOrder(seller, shopifyOrder(7001));
    let request = llm.requests.at(-1);
    check(/fraud_check/.test(request?.messages?.[0]?.content) && /never override the stock check, the stock numbers or a high fraud risk/.test(request.messages[0].content), 'the system prompt says how to read it');
    check(/verdict must be HOLD\./.test(request?.messages?.[1]?.content), 'the event says high risk means HOLD');
    check(
      JSON.stringify(fraudCheckSent(request)) ===
        JSON.stringify({ risk_level: 'high', recommendation: 'cancel', reasons: ['Card declined 4 times', 'Paid with a prepaid card'], billing_matches_shipping: false }),
      'the agent gets the level, advice, reasons and the address check',
      JSON.stringify(fraudCheckSent(request))
    );
    let decision = await decisionFor(seller, '#7001');
    check(
      decision?.action_taken === 'hold' &&
        decision.reasoning.startsWith('HOLD - fraud check: Shopify rates it high risk and recommends cancelling it (Card declined 4 times; Paid with a prepaid card)'),
      'the model said FULFILL: recorded as HOLD, with why',
      decision?.reasoning.split('\n')[0]
    );
    check(/FULFILL - looks fine/.test(decision?.reasoning), "the model's reply is kept below");
    check(alerts.at(-1)?.decisionId && /\*New order #7001\*\nHOLD - fraud check/.test(alerts.at(-1).text), 'the alert says HOLD, with rating buttons');
    let row = await orderRow(seller, 7001);
    check(
      row?.risk_level === 'high' && row.risk_recommendation === 'cancel' && row.billing_matches_shipping === 0 && row.risk_checked_at && row.risk_reasons?.length === 2,
      'saved on the order',
      `${row?.risk_level} ${row?.risk_recommendation} ${JSON.stringify(row?.risk_reasons)}`
    );

    risks.set('7002', riskNode(7002, 'MEDIUM', { recommendation: 'INVESTIGATE', reasons: ['Many payment attempts'] }));
    await newOrder(seller, shopifyOrder(7002));
    decision = await decisionFor(seller, '#7002');
    check(/HOLD for the seller to check, unless their notes say otherwise/.test(llm.requests.at(-1)?.messages?.[1]?.content), 'medium risk: the event says HOLD unless the notes say otherwise');
    check(decision?.action_taken === 'fulfill' && !/fraud check wins/.test(decision.reasoning), "but it's the model's call (a seller's note can allow it)", decision?.action_taken);

    risks.set('7003', riskNode(7003, 'LOW', { recommendation: 'ACCEPT', matches: false }));
    await newOrder(seller, shopifyOrder(7003));
    check(fraudCheckSent(llm.requests.at(-1))?.billing_matches_shipping === false && (await decisionFor(seller, '#7003'))?.action_taken === 'fulfill', 'low risk, addresses differ: FULFILL stands');

    console.log('\n2. A pending check');
    risks.set('7004', riskNode(7004, 'PENDING'));
    const before = { requests: llm.requests.length, runs: await runsFor(seller) };
    let deferred = null;
    try {
      await newOrder(seller, shopifyOrder(7004, 30 * 1000));
    } catch (err) {
      deferred = err;
    }
    check(deferred?.deferSeconds === 60 && /still pending/.test(deferred.message), 'a new order: the run asks to come back in a minute', deferred?.message);
    check(llm.requests.length === before.requests && (await runsFor(seller)) === before.runs && !(await decisionFor(seller, '#7004')), 'no model call, no run counted, no decision');
    check((await orderRow(seller, 7004))?.risk_level === 'pending', 'the order shows it as pending');

    risks.set('7005', riskNode(7005, 'PENDING'));
    await newOrder(seller, shopifyOrder(7005, 20 * 60 * 1000));
    check(/Fraud check: Shopify's analysis hasn't finished\./.test(llm.requests.at(-1)?.messages?.[1]?.content) && (await decisionFor(seller, '#7005')), 'placed 20 minutes ago: decides without it, and the event says so');

    risksFail = true;
    await newOrder(seller, shopifyOrder(7006));
    risksFail = false;
    check(
      /Fraud check: couldn't be read \(Shopify's fraud analysis couldn't be read\)\./.test(llm.requests.at(-1)?.messages?.[1]?.content) &&
        (await decisionFor(seller, '#7006')) &&
        (await orderRow(seller, 7006))?.risk_checked_at === null,
      "Shopify down: decides without it, says so, and saves nothing"
    );

    console.log('\n3. Through the job queue');
    const [[busy]] = await pool.query("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')");
    if (Number(busy.n) > 0) {
      check(false, `the job queue is empty (${busy.n} job(s) queued or running; run this test when it's empty)`);
    } else {
      risks.set('7007', riskNode(7007, 'PENDING'));
      const order = shopifyOrder(7007, 5 * 1000);
      await upsertOrder(seller, order);
      const jobId = await queueAgentRun(seller, { type: 'order_created', order });
      const jobRow = async () =>
        (await pool.query('SELECT status, attempts, last_error, run_after > NOW() + INTERVAL 30 SECOND AS later FROM jobs WHERE id = ?', [jobId]))[0][0];
      await queue.startWorker({ concurrency: 1 });
      const waiting = await until(async () => {
        const job = await jobRow();
        return job?.status === 'queued' && job.later ? job : null;
      });
      await queue.stopWorker(5000);
      check(waiting?.attempts === 0 && waiting.last_error === null, 'the run waits about a minute, without using a try', JSON.stringify(waiting));
      check(!(await decisionFor(seller, '#7007')), 'and nothing is decided yet');

      risks.set('7007', riskNode(7007, 'LOW', { recommendation: 'ACCEPT' }));
      await pool.query('UPDATE jobs SET run_after = NOW() WHERE id = ?', [jobId]); // a minute later
      await queue.startWorker({ concurrency: 1 });
      const done = await until(async () => {
        const job = await jobRow();
        return job?.status === 'done' ? job : null;
      });
      await queue.stopWorker(5000);
      check(done?.attempts === 1 && (await decisionFor(seller, '#7007'))?.action_taken === 'fulfill', 'once the check is in, it runs once and decides', JSON.stringify(done));
      check(fraudCheckSent(llm.requests.at(-1))?.risk_level === 'low', 'with the finished check');
    }

    console.log('\n4. The order sync reads it again');
    const store = await addSeller('sync');
    const addOrder = async (n, { hoursAgo = 24, status = 'unfulfilled', stored = null, alerted = false, verdict = null } = {}) => {
      const [r] = await pool.query(
        `INSERT INTO orders (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at,
           risk_level, risk_recommendation, risk_reasons, billing_matches_shipping, risk_checked_at, risk_alerted_at)
         VALUES (?, ?, ?, ?, 'paid', 'Ana Smith', 50.00, NOW() - INTERVAL ? HOUR, ?, ?, ?, ?, ?, ?)`,
        [
          store,
          String(n),
          `#${n}`,
          status,
          hoursAgo,
          stored?.level ?? null,
          stored?.recommendation ?? null,
          stored ? JSON.stringify(stored.reasons || []) : null,
          stored ? true : null,
          stored ? new Date(Date.now() - 3600 * 1000) : null,
          alerted ? new Date() : null,
        ]
      );
      if (verdict) {
        await pool.query(
          "INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken, created_at) VALUES (?, ?, ?, ?, ?, NOW() - INTERVAL 30 MINUTE)",
          [store, r.insertId, `#${n}`, `${verdict.toUpperCase()} - an earlier call`, verdict]
        );
      }
      return r.insertId;
    };
    const ids = {
      A: await addOrder(8001, { stored: { level: 'pending', recommendation: 'none' }, verdict: 'fulfill' }), // pending -> high: alert
      B: await addOrder(8002, { hoursAgo: 48, stored: { level: 'low', recommendation: 'accept' }, verdict: 'fulfill' }), // low -> medium: alert
      C: await addOrder(8003, { stored: { level: 'high', recommendation: 'cancel', reasons: ['Old reason'] }, verdict: 'hold' }), // was high already
      D: await addOrder(8004), // never checked, no decision yet: its run reads it
      E: await addOrder(8005, { status: 'fulfilled', verdict: 'fulfill' }), // shipped: not asked
      F: await addOrder(8006, { hoursAgo: 10 * 24, verdict: 'fulfill' }), // older than a week: not asked
      G: await addOrder(8007, { stored: { level: 'low', recommendation: 'none' }, alerted: true, verdict: 'fulfill' }), // alerted before
      H: await addOrder(8008, { verdict: 'fulfill' }), // never checked, comes back low
    };
    risks.set('8001', riskNode(8001, 'HIGH', { recommendation: 'CANCEL', reasons: ['Card declined 4 times'], matches: false }));
    risks.set('8002', riskNode(8002, 'MEDIUM', { recommendation: 'INVESTIGATE' }));
    risks.set('8003', riskNode(8003, 'HIGH', { recommendation: 'CANCEL', reasons: ['New reason'] }));
    risks.set('8004', riskNode(8004, 'HIGH', { recommendation: 'CANCEL' }));
    risks.set('8005', riskNode(8005, 'HIGH'));
    risks.set('8006', riskNode(8006, 'HIGH'));
    risks.set('8007', riskNode(8007, 'HIGH', { recommendation: 'CANCEL' }));
    risks.set('8008', riskNode(8008, 'LOW', { recommendation: 'ACCEPT' }));

    riskCalls.length = 0;
    alerts.length = 0;
    await syncOrders(store);
    const asked = (riskCalls[0] || []).slice().sort().join();
    check(riskCalls.length === 1 && asked === '8001,8002,8003,8004,8007,8008', 'one request for the open orders from the last week', asked);
    const alertedOn = alerts.map((a) => a.text.split('\n')[0]).sort();
    check(
      JSON.stringify(alertedOn) === JSON.stringify(['*Fraud risk: order #8001*', '*Fraud risk: order #8002*']),
      'alerts only where risk went up after a decision (not: already high, no decision yet, alerted before, came back low)',
      JSON.stringify(alertedOn)
    );
    const alertA = alerts.find((a) => a.text.startsWith('*Fraud risk: order #8001*'))?.text || '';
    check(
      alertA ===
        [
          '*Fraud risk: order #8001*',
          'Shopify now rates it high risk and recommends cancelling it.',
          'The agent said FULFILL before this came in: hold it until you have checked it.',
          '- Card declined 4 times',
          "- The billing address doesn't match the shipping address (or one is missing)",
          `Review it: https://dash.example.test/orders/${ids.A}`,
        ].join('\n'),
      'the alert says what changed, what the agent had said, and links to the order',
      JSON.stringify(alertA)
    );
    check(alerts.every((a) => !a.decisionId), 'without rating buttons (no agent decision to rate)');
    const rows = Object.fromEntries(
      await Promise.all(Object.entries(ids).map(async ([key, id]) => [key, (await pool.query('SELECT * FROM orders WHERE id = ?', [id]))[0][0]]))
    );
    check(rows.A.risk_alerted_at && rows.B.risk_alerted_at && !rows.C.risk_alerted_at && !rows.D.risk_alerted_at, 'the alerted orders are marked');
    check(rows.C.risk_reasons?.[0] === 'New reason' && rows.D.risk_level === 'high' && rows.H.risk_level === 'low', 'every order asked is saved with the new check');
    check(rows.E.risk_checked_at === null && rows.F.risk_checked_at === null, 'shipped and older orders are left alone');
    alerts.length = 0;
    await syncOrders(store);
    check(alerts.length === 0, 'the next sync alerts nothing again', `${alerts.length} alert(s)`);

    risksFail = true;
    const synced = await syncOrders(store);
    risksFail = false;
    check(/Synced/.test(synced?.message || ''), "Shopify down for the fraud check: the order sync still works", synced?.message);

    console.log('\n5. The API');
    let res = await get('/api/orders?risk=flagged&limit=50', store);
    const flagged = (res.body?.orders || []).map((o) => o.order_number).sort();
    check(res.status === 200 && JSON.stringify(flagged) === JSON.stringify(['#8001', '#8002', '#8003', '#8004', '#8007']), '?risk=flagged: high or medium, cancel or investigate', JSON.stringify(flagged));
    check(res.body?.total === 5, 'counted in total', res.body?.total);
    const listed = res.body?.orders?.find((o) => o.order_number === '#8001');
    check(
      listed?.risk?.level === 'high' && listed.risk.flagged === true && listed.risk.reasons?.[0] === 'Card declined 4 times' && listed.risk.billing_matches_shipping === false,
      'each order has `risk`',
      JSON.stringify(listed?.risk)
    );
    check(listed && !('risk_level' in listed) && !('risk_reasons' in listed) && !('risk_alerted_at' in listed), 'the raw columns are left out');
    res = await get('/api/orders?risk=high', store);
    check(res.status === 400 && /risk must be flagged/.test(res.body?.error), 'any other ?risk is refused', res.body?.error);
    res = await get('/api/orders/pending?limit=50', store);
    check(res.body?.pending_orders?.find((o) => o.order_number === '#8008')?.risk?.level === 'low', 'pending orders have it too');

    riskCalls.length = 0;
    risks.set('8006', riskNode(8006, 'MEDIUM', { reasons: ['Shipping to a freight forwarder'] }));
    res = await get(`/api/orders/${ids.F}`, store);
    check(
      res.status === 200 && res.body.order?.risk?.level === 'medium' && res.body.risk_note === null && riskCalls.length === 1,
      'an order never checked gets its check from Shopify when opened',
      JSON.stringify(res.body?.order?.risk)
    );
    res = await get(`/api/orders/${ids.F}`, store);
    check(riskCalls.length === 1, 'once');
    risks.delete('8005');
    res = await get(`/api/orders/${ids.E}`, store);
    check(res.status === 200 && res.body.order?.risk === null && res.body.risk_note === 'No fraud check: Shopify did not return this order.', 'when that fails the page still loads, with a note', res.body?.risk_note);

    console.log('\n6. Privacy');
    const data = await privacy.customerData(store, ['8001']);
    check(data.orders[0]?.risk_level === 'high' && data.orders[0].risk_reasons?.[0] === 'Card declined 4 times', "a data request includes the order's fraud check");
    await privacy.redactCustomer(store, ['8001']);
    const redacted = (await pool.query('SELECT buyer_name, risk_level, risk_reasons FROM orders WHERE id = ?', [ids.A]))[0][0];
    check(redacted.buyer_name === 'Redacted' && redacted.risk_reasons === null && redacted.risk_level === 'high', 'a redact removes its reasons (they can describe the buyer) and keeps the level');
  } finally {
    await queue.stopWorker(5000);
    llm.server.close();
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]); // line items go with them
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]); // their jobs and agent_runs go with them
    }
    console.log('\nRemoved the test sellers, their orders, decisions and jobs.');
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
