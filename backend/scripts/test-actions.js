// End-to-end check of holding and fulfilling orders in Shopify from here, run
// in-process against a fake Shopify (the shopifyService fulfillment calls)
// and a fake DeepSeek; alerts are captured instead of sent. The real database
// is used with throwaway sellers, removed at the end:
//   1. the order's Shopify status: fulfillment orders and what can be done,
//      or why nothing can (not connected, permission missing); other sellers' orders
//   2. hold, release (only this app's holds) and fulfill (with tracking) through
//      the API; what Shopify won't do now; Shopify refusing; bad input; API keys can't act
//   3. every attempt is logged, and a fulfilled order shows as fulfilled at once
//   4. settings: whether actions are allowed, and the auto-hold switch
//   5. auto-hold: the agent's HOLD goes on hold in Shopify with the right reason,
//      only when switched on; the alert says how it went, failures included
//   6. a fraud risk that rises after the agent said FULFILL is held too
//
// Usage:  npm run test:actions
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const http = require('http');
const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- a fake DeepSeek: answers `reply.text`, never a tool call ---
const reply = { text: 'HOLD - Payment still pending\n- wait for it' };
function startFakeLLM() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// --- a fake Shopify: one fulfillment order per order, which holds, releases and fulfills ---
const ACTIONS = { OPEN: ['CREATE_FULFILLMENT', 'HOLD'], ON_HOLD: ['RELEASE_HOLD', 'HOLD'], CLOSED: [] };
const store = new Map(); // shopify order id -> fulfillment order
const calls = [];
let refuseNext = null; // 'userError' | 'accessDenied' | 'network'
let holdSeq = 100;

function openFulfillmentOrder(orderId) {
  const fo = {
    id: String(orderId * 10),
    status: 'OPEN',
    assignedLocation: { name: 'Shop floor' },
    fulfillmentHolds: [],
    lineItems: { nodes: [{ remainingQuantity: 2, totalQuantity: 2, lineItem: { title: 'Linen scarf', variantTitle: null, sku: 'SC-1' } }] },
  };
  store.set(String(orderId), fo);
  return fo;
}
const view = (fo) => ({ ...fo, supportedActions: ACTIONS[fo.status].map((action) => ({ action })), fulfillmentHolds: fo.fulfillmentHolds.map((h) => ({ ...h })) });
function refusal() {
  const kind = refuseNext;
  refuseNext = null;
  if (kind === 'userError') throw Object.assign(new Error('The fulfillment order is not in a holdable state'), { userError: true });
  if (kind === 'accessDenied') throw Object.assign(new Error('Access denied'), { accessDenied: true });
  if (kind === 'network') throw new Error('socket hang up');
}
const byFulfillmentOrder = (id) => [...store.values()].find((fo) => fo.id === String(id));

function fakeShopify(shopifyService) {
  shopifyService.fetchFulfillmentOrders = async (shop, token, orderId) => {
    calls.push({ call: 'fetch', orderId: String(orderId) });
    const fo = store.get(String(orderId));
    return fo ? [view(fo)] : null;
  };
  shopifyService.holdFulfillmentOrder = async (shop, token, id, hold) => {
    calls.push({ call: 'hold', id, ...hold });
    refusal();
    const fo = byFulfillmentOrder(id);
    const holdId = String(holdSeq++);
    fo.fulfillmentHolds.push({ id: holdId, reason: hold.reason, reasonNotes: hold.reasonNotes ?? null, displayReason: hold.reason, heldByRequestingApp: true });
    fo.status = 'ON_HOLD';
    return { holdId };
  };
  shopifyService.releaseFulfillmentHolds = async (shop, token, id, holdIds) => {
    calls.push({ call: 'release', id, holdIds });
    refusal();
    const fo = byFulfillmentOrder(id);
    fo.fulfillmentHolds = fo.fulfillmentHolds.filter((h) => !holdIds.includes(h.id));
    if (!fo.fulfillmentHolds.length) fo.status = 'OPEN';
    return { status: fo.status };
  };
  shopifyService.createFulfillment = async (shop, token, id, options) => {
    calls.push({ call: 'fulfill', id, ...options });
    refusal();
    const fo = byFulfillmentOrder(id);
    fo.status = 'CLOSED';
    for (const item of fo.lineItems.nodes) item.remainingQuantity = 0;
    return { fulfillmentId: '777' };
  };
  // The order as Shopify has it now (fulfilled once its fulfillment order closed).
  shopifyService.fetchOrder = async (shop, token, orderId) => {
    const fo = store.get(String(orderId));
    if (!fo) return null;
    return { id: Number(orderId), name: `#${orderId}`, fulfillment_status: fo.status === 'CLOSED' ? 'fulfilled' : null, financial_status: 'paid', total_price: '40.00', created_at: '2026-09-26T08:00:00+00:00' };
  };
  shopifyService.fetchOrders = async () => [];
  shopifyService.fetchOrdersByIds = async () => [];
}

const lastCall = (kind) => calls.filter((c) => c.call === kind).at(-1);
const countCalls = (kind) => calls.filter((c) => c.call === kind).length;

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
  require('../src/services/notifier').postDecision = async (sellerId, text) => (alerts.push({ sellerId, text }), []);
  const shopifyService = require('../src/services/shopifyService');
  fakeShopify(shopifyService);
  let risk = null; // what the fraud check says for new orders (a GraphQL node), or none
  shopifyService.fetchOrderRisks = async (shop, token, ids) => new Map(risk ? ids.map((id) => [String(id), { id: `gid://shopify/Order/${id}`, ...risk }]) : []);

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET, encryptSecret } = require('../src/config/secrets');
  const { createApiKey } = require('../src/models/apiKeyModel');
  const { upsertOrder } = require('../src/models/orderModel');
  const { runAgent } = require('../src/services/agentService');
  const { syncOrders } = require('../src/services/syncService');

  const run = crypto.randomBytes(3).toString('hex');
  const ALL_SCOPES = 'read_orders,read_products,read_inventory,write_merchant_managed_fulfillment_orders';
  const sellerIds = [];
  const addSeller = async (name, { connected = true, scopes = ALL_SCOPES } = {}) => {
    const [r] = await pool.query(
      `INSERT INTO sellers (business_name, email, password_hash, shopify_shop_domain, shopify_access_token, shopify_scopes)
       VALUES (?, ?, 'x', ?, ?, ?)`,
      [name, `actions-${run}-${name}@example.test`, connected ? `actions-${run}-${name}.myshopify.com` : null, connected ? encryptSecret('shpat_fake') : null, connected ? scopes : null]
    );
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  // An order in our table and in the fake Shopify.
  const addOrder = async (sellerId, shopifyId, extra = {}) => {
    openFulfillmentOrder(shopifyId);
    return upsertOrder(sellerId, {
      id: shopifyId,
      name: `#${shopifyId}`,
      created_at: '2026-09-26T08:00:00+00:00',
      fulfillment_status: null,
      financial_status: 'paid',
      total_price: '40.00',
      customer: { first_name: 'Ana', last_name: 'Smith' },
      ...extra,
    });
  };
  const logFor = async (orderId) =>
    (await pool.query('SELECT action, source, reason, note, ok, error FROM order_actions WHERE order_id = ? ORDER BY id', [orderId]))[0];

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const request = async (method, route, { sellerId = null, key = null, body } = {}) => {
    const auth = key ?? jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' });
    const res = await fetch(base + route, {
      method,
      headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    const seller = await addSeller('main');
    const noScope = await addSeller('noscope', { scopes: 'read_orders,read_products,read_inventory' });
    const unconnected = await addSeller('unconnected', { connected: false });
    const other = await addSeller('other');
    const { key } = await createApiKey(seller, 'actions test');

    console.log("\n1. The order's Shopify status");
    const orderId = await addOrder(seller, 6101);
    let res = await request('GET', `/api/orders/${orderId}/shopify`, { sellerId: seller });
    const fo = res.body?.fulfillment_orders?.[0];
    check(res.status === 200 && res.body.allowed === true && res.body.note === null, 'allowed, live from Shopify', JSON.stringify(res.body && { allowed: res.body.allowed, note: res.body.note }));
    check(
      fo?.id === '61010' && fo.status === 'open' && fo.location === 'Shop floor' && fo.can_hold && fo.can_fulfill && !fo.can_release && fo.items?.[0]?.remaining === 2,
      'its fulfillment order: status, location, items, what can be done',
      JSON.stringify(fo)
    );
    check(Array.isArray(res.body?.actions) && res.body.actions.length === 0, 'nothing done from here yet');
    res = await request('GET', `/api/orders/${orderId}/shopify`, { key });
    check(res.status === 200 && res.body.allowed === true, 'an API key can read it');

    const noScopeOrder = await addOrder(noScope, 6102);
    const fetchesBefore = countCalls('fetch');
    res = await request('GET', `/api/orders/${noScopeOrder}/shopify`, { sellerId: noScope });
    check(res.body?.allowed === false && /Reconnect it in Settings > Store/.test(res.body.note) && res.body.fulfillment_orders === null, 'permission missing: not allowed, says how to fix it', res.body?.note);
    check(countCalls('fetch') === fetchesBefore, 'without asking Shopify');
    const [loose] = await pool.query(
      "INSERT INTO orders (seller_id, shopify_order_id, order_number, status, financial_status, total_amount, order_placed_at) VALUES (?, '6103', '#6103', 'unfulfilled', 'paid', 1, NOW())",
      [unconnected]
    );
    res = await request('GET', `/api/orders/${loose.insertId}/shopify`, { sellerId: unconnected });
    check(res.body?.allowed === false && /Connect your Shopify store/.test(res.body.note), 'not connected: says to connect', res.body?.note);
    res = await request('GET', `/api/orders/${orderId}/shopify`, { sellerId: other });
    check(res.status === 404, "another seller's order is not found", String(res.status));

    console.log('\n2. Hold, release, fulfill');
    res = await request('POST', `/api/orders/${orderId}/hold`, { key, body: { fulfillment_order_id: '61010', reason: 'OTHER' } });
    check(res.status === 403 && /API keys can only read/.test(res.body?.error), 'an API key cannot act', res.body?.error);
    res = await request('POST', `/api/orders/${orderId}/hold`, { sellerId: seller, body: { fulfillment_order_id: '61010', reason: 'NOPE' } });
    check(res.status === 400 && /reason must be one of/.test(res.body?.error), 'a bad body is refused', res.body?.error);

    res = await request('POST', `/api/orders/${orderId}/hold`, { sellerId: seller, body: { fulfillment_order_id: '61010', reason: 'HIGH_RISK_OF_FRAUD', note: 'Card declined 4 times' } });
    let held = res.body?.fulfillment_orders?.[0];
    check(res.status === 200 && held?.status === 'on_hold' && held.can_release && !held.can_hold && !held.can_fulfill, 'hold: the answer is the state after it', JSON.stringify(held && { status: held.status, can_release: held.can_release }));
    const holdCall = lastCall('hold');
    check(holdCall?.reason === 'HIGH_RISK_OF_FRAUD' && holdCall.reasonNotes === 'Card declined 4 times' && holdCall.handle === 'ai-ops', "Shopify gets the reason, the note and this app's handle", JSON.stringify(holdCall));
    res = await request('POST', `/api/orders/${orderId}/hold`, { sellerId: seller, body: { fulfillment_order_id: '61010', reason: 'OTHER' } });
    check(res.status === 409 && /won't hold this now/.test(res.body?.error), 'held already: refused before Shopify is asked', res.body?.error);
    res = await request('POST', `/api/orders/${orderId}/fulfill`, { sellerId: seller, body: { fulfillment_order_id: '61010' } });
    check(res.status === 409 && /won't fulfill this now/.test(res.body?.error) && countCalls('fulfill') === 0, 'on hold: fulfilling is refused', res.body?.error);
    res = await request('POST', `/api/orders/${orderId}/hold`, { sellerId: seller, body: { fulfillment_order_id: '99999', reason: 'OTHER' } });
    check(res.status === 404 && /isn't part of this order/.test(res.body?.error), "a fulfillment order from another order is refused", res.body?.error);

    // Another app holds it too: releasing ours leaves theirs.
    store.get('6101').fulfillmentHolds.push({ id: '55', reason: 'OTHER', reasonNotes: null, displayReason: 'Other', heldByRequestingApp: false });
    res = await request('POST', `/api/orders/${orderId}/release`, { sellerId: seller, body: { fulfillment_order_id: '61010' } });
    check(res.status === 200 && JSON.stringify(lastCall('release')?.holdIds) === JSON.stringify([String(holdSeq - 1)]), "release: only this app's hold", JSON.stringify(lastCall('release')));
    held = res.body?.fulfillment_orders?.[0];
    check(held?.status === 'on_hold' && held.holds.length === 1 && held.holds[0].ours === false && !held.can_release, "the other app's hold stays, and isn't ours to release", JSON.stringify(held?.holds));
    store.get('6101').fulfillmentHolds = [];
    store.get('6101').status = 'OPEN';

    refuseNext = 'userError';
    res = await request('POST', `/api/orders/${orderId}/hold`, { sellerId: seller, body: { fulfillment_order_id: '61010', reason: 'OTHER' } });
    check(res.status === 422 && res.body?.error === 'Shopify said: The fulfillment order is not in a holdable state', "Shopify refusing: its own words", res.body?.error);
    refuseNext = 'network';
    res = await request('POST', `/api/orders/${orderId}/hold`, { sellerId: seller, body: { fulfillment_order_id: '61010', reason: 'OTHER' } });
    check(res.status === 502 && /couldn't be reached/.test(res.body?.error), 'Shopify down: says so', res.body?.error);
    res = await request('POST', `/api/orders/${noScopeOrder}/hold`, { sellerId: noScope, body: { fulfillment_order_id: '61020', reason: 'OTHER' } });
    check(res.status === 409 && /Reconnect it in Settings > Store/.test(res.body?.error), 'permission missing: says how to fix it', res.body?.error);

    res = await request('POST', `/api/orders/${orderId}/fulfill`, {
      sellerId: seller,
      body: { fulfillment_order_id: '61010', notify_customer: true, tracking_number: '1Z999', tracking_company: 'UPS' },
    });
    const fulfillCall = lastCall('fulfill');
    check(res.status === 200 && res.body.fulfillment_orders?.[0]?.status === 'closed', 'fulfill: shipped', JSON.stringify(res.body?.fulfillment_orders?.[0]?.status));
    check(fulfillCall?.notifyCustomer === true && JSON.stringify(fulfillCall.tracking) === JSON.stringify({ number: '1Z999', company: 'UPS' }), 'with the tracking number and carrier, and the customer emailed', JSON.stringify(fulfillCall));

    console.log('\n3. The log, and the order afterwards');
    const log = await logFor(orderId);
    const summary = log.map((a) => `${a.action}:${a.ok ? 'ok' : 'failed'}`).join(' ');
    check(summary === 'hold:ok release:ok hold:failed hold:failed fulfill:ok', 'every attempt that reached Shopify is logged', summary);
    check(log[0].source === 'seller' && log[0].reason === 'HIGH_RISK_OF_FRAUD' && log[0].note === 'Card declined 4 times' && log[4].note === '1Z999', 'with who, the reason, the note and the tracking number');
    check(/holdable state/.test(log[2].error) && /couldn't be reached/.test(log[3].error), "and why Shopify refused");
    const [[shipped]] = await pool.query('SELECT status FROM orders WHERE id = ?', [orderId]);
    check(shipped.status === 'fulfilled', 'the order shows as fulfilled at once', shipped.status);
    res = await request('GET', `/api/orders/${orderId}/shopify`, { sellerId: seller });
    check(res.body?.actions?.length === 5 && res.body.actions[0].action === 'fulfill' && res.body.actions[0].ok === true, 'the log comes with the status, newest first');

    console.log('\n4. Settings');
    res = await request('GET', '/api/settings', { sellerId: seller });
    check(JSON.stringify(res.body?.shopify_actions) === JSON.stringify({ allowed: true, auto_hold: false }), 'allowed; auto-hold off by default', JSON.stringify(res.body?.shopify_actions));
    check(res.body?.store?.missing_scopes?.length === 0, 'no permission missing');
    res = await request('GET', '/api/settings', { sellerId: noScope });
    check(
      res.body?.shopify_actions?.allowed === false && res.body.store.missing_scopes.includes('write_merchant_managed_fulfillment_orders'),
      'a store connected before: not allowed, and the permission shows as missing',
      JSON.stringify(res.body?.store?.missing_scopes)
    );
    res = await request('PUT', '/api/settings/auto-hold', { sellerId: seller, body: { enabled: 'yes' } });
    check(res.status === 400, 'auto-hold must be true or false');
    res = await request('PUT', '/api/settings/auto-hold', { key, body: { enabled: true } });
    check(res.status === 403, 'an API key cannot switch it');

    console.log('\n5. Auto-hold');
    const agentOrder = async (sellerId, n, financial = 'pending') => {
      const order = { id: n, name: `#${n}`, created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00'), financial_status: financial, total_price: '40.00', line_items: [{ id: n * 10, variant_id: null, title: 'Gift wrap', quantity: 1 }] };
      await addOrder(sellerId, n, { financial_status: financial });
      alerts.length = 0;
      await runAgent(sellerId, { type: 'order_created', order });
      return alerts.at(-1)?.text || '';
    };
    reply.text = 'HOLD - Payment still pending\n- wait for it';
    const holdsBefore = countCalls('hold');
    let alert = await agentOrder(seller, 6201);
    check(countCalls('hold') === holdsBefore && !/on hold in Shopify/.test(alert), 'switched off: the HOLD stays advice');

    res = await request('PUT', '/api/settings/auto-hold', { sellerId: seller, body: { enabled: true } });
    check(res.status === 200 && res.body?.shopify_actions?.auto_hold === true, 'switched on');
    alert = await agentOrder(seller, 6202);
    let call = lastCall('hold');
    check(call?.id === '62020' && call.reason === 'AWAITING_PAYMENT' && call.reasonNotes === 'Payment still pending' && call.handle === 'ai-ops', 'a HOLD goes on hold in Shopify, with the reason and the headline', JSON.stringify(call));
    check(/\n\nPut on hold in Shopify \(awaiting payment\)\.$/.test(alert), 'the alert says so', JSON.stringify(alert.split('\n').at(-1)));
    const [[agentLog]] = await pool.query("SELECT a.source, a.ok FROM order_actions a JOIN orders o ON o.id = a.order_id WHERE o.seller_id = ? AND o.shopify_order_id = '6202'", [seller]);
    check(agentLog?.source === 'agent' && agentLog.ok === 1, "logged as the agent's");

    risk = { requiresShipping: true, billingAddressMatchesShippingAddress: true, risk: { recommendation: 'CANCEL', assessments: [{ riskLevel: 'HIGH', facts: [] }] } };
    reply.text = 'FULFILL - looks fine\n- ok';
    alert = await agentOrder(seller, 6203, 'paid');
    risk = null;
    check(lastCall('hold')?.id === '62030' && lastCall('hold').reason === 'HIGH_RISK_OF_FRAUD' && /Put on hold in Shopify \(high risk of fraud\)\./.test(alert), 'high fraud risk (FULFILL overridden to HOLD): held as fraud risk');

    const beforeFulfill = countCalls('hold');
    alert = await agentOrder(seller, 6204, 'paid');
    check(countCalls('hold') === beforeFulfill && !/Shopify/.test(alert.split('\n').at(-1)), 'a FULFILL is never acted on');

    reply.text = 'HOLD - Payment still pending\n- wait for it';
    refuseNext = 'userError';
    alert = await agentOrder(seller, 6205);
    check(/Couldn't put it on hold in Shopify: Shopify said: The fulfillment order is not in a holdable state$/.test(alert), 'Shopify refusing: the alert says why', JSON.stringify(alert.split('\n').at(-1)));
    await pool.query('UPDATE sellers SET auto_hold = TRUE WHERE id = ?', [noScope]);
    alert = await agentOrder(noScope, 6206);
    check(/Couldn't put it on hold in Shopify: Your store hasn't allowed/.test(alert), 'permission missing: the alert says how to fix it');
    const [[failedLog]] = await pool.query("SELECT a.ok, a.error FROM order_actions a JOIN orders o ON o.id = a.order_id WHERE o.seller_id = ? AND o.shopify_order_id = '6206'", [noScope]);
    check(failedLog?.ok === 0 && /Reconnect/.test(failedLog.error), 'and the failure is logged on the order');

    console.log('\n6. A fraud risk that rises later');
    const rising = await addOrder(seller, 6301);
    await pool.query("UPDATE orders SET risk_level = 'pending', risk_recommendation = 'none', risk_reasons = '[]', risk_checked_at = NOW(), order_placed_at = NOW() - INTERVAL 1 HOUR WHERE id = ?", [rising]);
    await pool.query("INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken) VALUES (?, ?, '#6301', 'FULFILL - fine', 'fulfill')", [seller, rising]);
    shopifyService.fetchOrderRisks = async (shop, token, ids) =>
      new Map(ids.filter((id) => String(id) === '6301').map((id) => [String(id), { id: `gid://shopify/Order/${id}`, requiresShipping: true, billingAddressMatchesShippingAddress: true, risk: { recommendation: 'CANCEL', assessments: [{ riskLevel: 'HIGH', facts: [{ description: 'Card declined 4 times', sentiment: 'NEGATIVE' }] }] } }]));
    alerts.length = 0;
    await syncOrders(seller);
    const riskAlert = alerts.find((a) => a.text.startsWith('*Fraud risk: order #6301*'))?.text || '';
    check(lastCall('hold')?.id === '63010' && lastCall('hold').reason === 'HIGH_RISK_OF_FRAUD', 'with auto-hold on, the order is held in Shopify', JSON.stringify(lastCall('hold')));
    check(/\nPut on hold in Shopify \(high risk of fraud\)\.\nReview it:/.test(riskAlert), 'and the fraud alert says so', JSON.stringify(riskAlert));

    console.log('\n7. Privacy');
    const privacy = require('../src/models/privacyModel');
    const [[named]] = await pool.query("SELECT id FROM orders WHERE seller_id = ? AND shopify_order_id = '6204'", [seller]);
    res = await request('POST', `/api/orders/${named.id}/hold`, { sellerId: seller, body: { fulfillment_order_id: '62040', reason: 'OTHER', note: 'Ana Smith asked us to wait' } });
    const data = await privacy.customerData(seller, ['6101', '6204']);
    const noted = data.shopify_actions.map((a) => `${a.order_number} ${a.action} ${a.note ?? ''}`.trim()).sort();
    check(
      res.status === 200 && JSON.stringify(noted) === JSON.stringify(['#6101 fulfill 1Z999', '#6101 hold Card declined 4 times', '#6101 release', '#6204 hold Ana Smith asked us to wait']),
      'a data request includes what was done from here (failed attempts left out)',
      JSON.stringify(noted)
    );
    await privacy.redactCustomer(seller, ['6204']);
    const [[scrubbed]] = await pool.query('SELECT note FROM order_actions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [named.id]);
    check(scrubbed?.note === '[redacted] asked us to wait', "a redact scrubs the buyer's name from hold notes", scrubbed?.note);
  } finally {
    llm.server.close();
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]); // line items and actions go with them
      await pool.query('DELETE FROM api_keys WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]); // their agent runs go with them
    }
    console.log('\nRemoved the test sellers, their orders, decisions and actions.');
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
