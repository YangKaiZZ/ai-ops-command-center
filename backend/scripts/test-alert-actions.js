// End-to-end check of holding and fulfilling orders from alerts, run
// in-process against a fake Shopify (the shopifyService fulfillment calls), a
// fake SMTP server and a fake Telegram API on localhost (nothing is really
// sent; the real database is used with throwaway sellers, removed at the end):
//   1. alerts about an order carry hold / fulfill links (email) and buttons
//      (Telegram), only when the seller can act from here
//   2. the confirm page's API: signed, one order and one action, expiring;
//      opening it only reads; hold and fulfill go through, logged as "link";
//      what Shopify won't do now; another seller's order; a missing permission
//   3. Telegram: a tap asks first (with the hold reason), Cancel changes
//      nothing, Yes acts (logged as "telegram"), only from the seller's own
//      chat; rating keeps the hold / fulfill buttons
//
// Usage:  npm run test:alert-actions
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const net = require('net');
const http = require('http');
const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(50);
  }
  return null;
}

// --- a fake SMTP server: accepts every message and keeps it ---
function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 fake-smtp ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ raw: data });
            data = '';
            socket.write('250 queued\r\n');
          } else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-fake-smtp\r\n250 8BITMIME\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.address().port })));
}
const mailBody = (m) => m.raw.split('\n\n').slice(1).join('\n\n').replace(/=\n/g, '').replace(/=3D/g, '=');

// --- a fake Telegram Bot API: records every call ---
function startFakeTelegram() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const params = body ? JSON.parse(body) : {};
      calls.push({ method, params });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: method === 'sendMessage' ? { message_id: 1000 + calls.length } : true }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

// --- a fake Shopify: one fulfillment order per order, which holds and fulfills ---
const ACTIONS = { OPEN: ['CREATE_FULFILLMENT', 'HOLD'], ON_HOLD: ['RELEASE_HOLD', 'HOLD'], CLOSED: [] };
const store = new Map(); // shopify order id -> fulfillment order
const calls = [];
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
}
const view = (fo) => ({ ...fo, supportedActions: ACTIONS[fo.status].map((action) => ({ action })), fulfillmentHolds: fo.fulfillmentHolds.map((h) => ({ ...h })) });
const byFulfillmentOrder = (id) => [...store.values()].find((fo) => fo.id === String(id));
function fakeShopify(shopifyService) {
  shopifyService.fetchFulfillmentOrders = async (shop, token, orderId) => {
    calls.push({ call: 'fetch', orderId: String(orderId) });
    const fo = store.get(String(orderId));
    return fo ? [view(fo)] : null;
  };
  shopifyService.holdFulfillmentOrder = async (shop, token, id, hold) => {
    calls.push({ call: 'hold', id, ...hold });
    const fo = byFulfillmentOrder(id);
    fo.fulfillmentHolds.push({ id: String(holdSeq++), reason: hold.reason, reasonNotes: hold.reasonNotes ?? null, displayReason: hold.reason, heldByRequestingApp: true });
    fo.status = 'ON_HOLD';
    return { holdId: '1' };
  };
  shopifyService.createFulfillment = async (shop, token, id, options) => {
    calls.push({ call: 'fulfill', id, ...options });
    const fo = byFulfillmentOrder(id);
    fo.status = 'CLOSED';
    for (const item of fo.lineItems.nodes) item.remainingQuantity = 0;
    return { fulfillmentId: '777' };
  };
  shopifyService.fetchOrder = async (shop, token, orderId) => {
    const fo = store.get(String(orderId));
    if (!fo) return null;
    return { id: Number(orderId), name: `#${orderId}`, fulfillment_status: fo.status === 'CLOSED' ? 'fulfilled' : null, financial_status: 'paid', total_price: '40.00', created_at: '2026-09-26T08:00:00+00:00' };
  };
}
const countCalls = (kind) => calls.filter((c) => c.call === kind).length;
const lastCall = (kind) => calls.filter((c) => c.call === kind).at(-1);

async function main() {
  const smtp = await startFakeSmtp();
  const tg = await startFakeTelegram();
  Object.assign(process.env, {
    SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
    EMAIL_FROM: 'Arbiter Ops <alerts@example.test>',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_API_BASE: `http://127.0.0.1:${tg.port}`,
    DASHBOARD_URL: 'https://ops.example.test',
  });
  require('dotenv').config({ quiet: true });

  const shopifyService = require('../src/services/shopifyService');
  fakeShopify(shopifyService);
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET, encryptSecret } = require('../src/config/secrets');
  const { upsertOrder } = require('../src/models/orderModel');
  const { postDecision } = require('../src/services/notifier');
  const { orderActionToken } = require('../src/services/actionLinks');
  const telegram = require('../src/services/telegram');

  const run = crypto.randomBytes(3).toString('hex');
  const ALL_SCOPES = 'read_orders,read_products,read_inventory,write_merchant_managed_fulfillment_orders';
  const sellerIds = [];
  const addSeller = async (name, { connected = true, scopes = ALL_SCOPES, chat = null } = {}) => {
    const [r] = await pool.query(
      `INSERT INTO sellers (business_name, email, password_hash, shopify_shop_domain, shopify_access_token, shopify_scopes, alert_email, telegram_chat_id)
       VALUES (?, ?, 'x', ?, ?, ?, ?, ?)`,
      [
        name,
        `alertact-${run}-${name}@example.test`,
        connected ? `alertact-${run}-${name}.myshopify.com` : null,
        connected ? encryptSecret('shpat_fake') : null,
        connected ? scopes : null,
        `owner-${run}-${name}@example.test`,
        chat,
      ]
    );
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  const addOrder = async (sellerId, shopifyId, extra = {}) => {
    openFulfillmentOrder(shopifyId);
    return upsertOrder(sellerId, {
      id: shopifyId,
      name: `#${shopifyId}`,
      created_at: '2026-09-26T08:00:00+00:00',
      fulfillment_status: null,
      financial_status: 'paid',
      total_price: '40.00',
      customer: null,
      ...extra,
    });
  };
  const addDecision = async (sellerId, orderId, number, reasoning, action) =>
    (
      await pool.query('INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken) VALUES (?, ?, ?, ?, ?)', [
        sellerId,
        orderId,
        number,
        reasoning,
        action,
      ])
    )[0].insertId;
  const logFor = async (orderId) => (await pool.query('SELECT action, source, reason, note, ok FROM order_actions WHERE order_id = ? ORDER BY id', [orderId]))[0];

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const request = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const link = (orderId, sellerId, action, nowMs) => `/api/act/${encodeURIComponent(orderActionToken(orderId, sellerId, action, nowMs))}`;

  // Telegram: a tap on a button in the seller's chat (4242 unless said otherwise).
  let updateId = 1;
  let callbackId = 1;
  const tap = async (data, { chat = 4242, messageId = 55, keyboard } = {}) => {
    const id = `cb${callbackId++}`;
    const from = tg.calls.length;
    await telegram.handleUpdate({
      update_id: updateId++,
      callback_query: { id, data, message: { message_id: messageId, chat: { id: chat }, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) } },
    });
    const made = tg.calls.slice(from);
    return {
      answer: made.find((c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === id)?.params.text,
      sent: made.find((c) => c.method === 'sendMessage')?.params,
      edited: made.find((c) => c.method === 'editMessageText')?.params,
      markup: made.find((c) => c.method === 'editMessageReplyMarkup')?.params,
    };
  };

  try {
    const seller = await addSeller('main', { chat: '4242' });
    const noScope = await addSeller('noscope', { scopes: 'read_orders,read_products,read_inventory' });
    const unconnected = await addSeller('unconnected', { connected: false });
    const other = await addSeller('other');

    console.log('\n1. Alerts carry the links and buttons');
    const orderA = await addOrder(seller, 7101);
    await pool.query("UPDATE orders SET risk_level = 'high', risk_recommendation = 'cancel' WHERE id = ?", [orderA]);
    const decision = { id: await addDecision(seller, orderA, '#7101', 'HOLD - fraud', 'hold') };
    const mailsBefore = smtp.messages.length;
    const tgBefore = tg.calls.length;
    let results = await postDecision(seller, '*New order #7101*\nHOLD - fraud', { decisionId: decision.id, orderId: orderA });
    check(results.length === 2 && results.every((r) => r.ok), 'sent to email and Telegram', JSON.stringify(results));
    const mail = await until(() => smtp.messages.slice(mailsBefore).at(-1));
    const body = mail ? mailBody(mail) : '';
    const holdUrl = body.match(/Put on hold: (\S+)/)?.[1];
    const fulfillUrl = body.match(/Mark fulfilled: (\S+)/)?.[1];
    check(
      /In Shopify \(each link opens a page to confirm, and works for 7 days\)/.test(body) &&
        holdUrl?.startsWith('https://ops.example.test/act?t=') &&
        fulfillUrl?.startsWith('https://ops.example.test/act?t='),
      'the email has a link to hold it and one to fulfill it',
      `${holdUrl} ${fulfillUrl}`
    );
    const sentTg = tg.calls.slice(tgBefore).find((c) => c.method === 'sendMessage');
    const rows = sentTg?.params.reply_markup?.inline_keyboard?.map((row) => row.map((b) => b.callback_data));
    check(JSON.stringify(rows) === JSON.stringify([[`rate:${decision.id}:up`, `rate:${decision.id}:down`], [`act:${orderA}:hold`, `act:${orderA}:fulfill`]]), 'Telegram gets rating buttons and hold / fulfill buttons', JSON.stringify(rows));

    for (const [who, id, label] of [
      [noScope, await addOrder(noScope, 7201), 'a store that refused the permission'],
      [unconnected, (await pool.query("INSERT INTO orders (seller_id, shopify_order_id, order_number, status) VALUES (?, '7301', '#7301', 'unfulfilled')", [unconnected]))[0].insertId, 'no store connected'],
    ]) {
      const before = smtp.messages.length;
      await postDecision(who, '*New order*\nFULFILL - ok', { orderId: id });
      const m = await until(() => smtp.messages.slice(before).at(-1));
      check(m && !/In Shopify/.test(mailBody(m)), `no hold / fulfill links for ${label}`);
    }
    const plainBefore = smtp.messages.length;
    await postDecision(seller, '*Daily summary*');
    const plain = await until(() => smtp.messages.slice(plainBefore).at(-1));
    check(plain && !/In Shopify/.test(mailBody(plain)), 'no links on an alert about no one order');

    console.log('\n2. The confirm page behind the links');
    const holdLink = `/api/act/${new URL(holdUrl).searchParams.get('t')}`;
    const holdsBefore = countCalls('hold');
    let res = await request('GET', holdLink);
    const fo = res.body?.state?.fulfillment_orders?.[0];
    check(
      res.status === 200 && res.body.action === 'hold' && res.body.order?.order_number === '#7101' && res.body.business_name === 'main' && res.body.order.flagged === true,
      'opening the link shows the order, the action and whose it is (no sign-in)',
      JSON.stringify(res.body && { action: res.body.action, order: res.body.order, business: res.body.business_name })
    );
    check(res.body?.order?.suggested_reason === 'HIGH_RISK_OF_FRAUD', 'with the hold reason to start from (fraud, since it was flagged)', res.body?.order?.suggested_reason);
    check(fo?.id === '71010' && fo.can_hold && fo.can_fulfill && Array.isArray(res.body.state.actions) && res.body.state.actions.length === 0, 'and the order live from Shopify, without the log', JSON.stringify(fo));
    check(new Date(res.body?.expires_at) - Date.now() > 6.9 * 86400000, 'and when the link expires', res.body?.expires_at);
    check(countCalls('hold') === holdsBefore, 'opening it changes nothing in Shopify');

    res = await request('POST', holdLink, { fulfillment_order_id: '71010' });
    check(res.status === 400 && /reason/.test(res.body?.error), 'a hold needs a reason', res.body?.error);
    res = await request('POST', holdLink, { fulfillment_order_id: '71010', reason: 'HIGH_RISK_OF_FRAUD', note: 'Card declined 4 times' });
    check(res.status === 200 && res.body.fulfillment_orders?.[0]?.status === 'on_hold' && res.body.actions.length === 0, 'confirming puts it on hold', JSON.stringify(res.body?.fulfillment_orders?.[0]?.status));
    check(lastCall('hold')?.reason === 'HIGH_RISK_OF_FRAUD' && lastCall('hold').reasonNotes === 'Card declined 4 times' && lastCall('hold').handle === 'ai-ops', "in Shopify, with the reason, note and this app's handle");
    let log = await logFor(orderA);
    check(log.length === 1 && log[0].source === 'link' && log[0].action === 'hold' && log[0].ok === 1, 'logged as done from an alert link', JSON.stringify(log));
    res = await request('POST', holdLink, { fulfillment_order_id: '71010', reason: 'OTHER' });
    check(res.status === 409 && /won't hold/.test(res.body?.error), 'a second click: Shopify won\'t hold it again', res.body?.error);
    const fulfillLinkA = `/api/act/${new URL(fulfillUrl).searchParams.get('t')}`;
    res = await request('GET', fulfillLinkA);
    check(res.status === 200 && res.body.action === 'fulfill' && res.body.state.fulfillment_orders[0].can_fulfill === false, "the fulfill link shows it can't be fulfilled while on hold");
    res = await request('POST', fulfillLinkA, { fulfillment_order_id: '71010' });
    check(res.status === 409 && /won't fulfill/.test(res.body?.error), 'and confirming is refused', res.body?.error);

    const orderB = await addOrder(seller, 7102, { financial_status: 'pending' });
    res = await request('GET', link(orderB, seller, 'fulfill'));
    check(res.status === 200 && res.body.order.suggested_reason === 'AWAITING_PAYMENT', 'a pending payment suggests "awaiting payment"', res.body?.order?.suggested_reason);
    res = await request('POST', link(orderB, seller, 'fulfill'), { fulfillment_order_id: '71020', notify_customer: false, tracking_number: '1Z999', tracking_company: 'UPS' });
    check(res.status === 200 && res.body.fulfillment_orders?.[0]?.status === 'closed', 'the fulfill link marks it fulfilled', JSON.stringify(res.body?.fulfillment_orders?.[0]?.status));
    check(lastCall('fulfill')?.notifyCustomer === false && lastCall('fulfill').tracking?.number === '1Z999', 'with the tracking and email choice given');
    const [[shipped]] = await pool.query('SELECT status FROM orders WHERE id = ?', [orderB]);
    check(shipped.status === 'fulfilled', 'and the order shows as fulfilled here at once', shipped.status);
    log = await logFor(orderB);
    check(log.length === 1 && log[0].source === 'link' && log[0].action === 'fulfill' && log[0].note === '1Z999', 'logged as done from an alert link', JSON.stringify(log));
    res = await request('POST', link(orderB, seller, 'hold'), { fulfillment_order_id: '71020', reason: 'OTHER' });
    check(res.status === 409, 'a hold link on a shipped order is refused', res.body?.error);

    const tampered = orderActionToken(orderB, seller, 'hold').replace(`${orderB}.${seller}.hold`, `${orderB}.${seller}.fulfill`);
    res = await request('GET', `/api/act/${tampered}`);
    check(res.status === 404 && res.body?.error === "This link isn't valid.", "a link changed to another action isn't valid", res.body?.error);
    res = await request('GET', link(orderB, seller, 'hold', Date.now() - 8 * 86400000));
    check(res.status === 410 && /expired/.test(res.body?.error), 'a link older than a week has expired', res.body?.error);
    res = await request('POST', link(orderB, seller, 'hold', Date.now() - 8 * 86400000), { fulfillment_order_id: '71020', reason: 'OTHER' });
    check(res.status === 410, 'and does nothing');
    const otherOrder = await addOrder(other, 7401);
    res = await request('GET', link(otherOrder, seller, 'hold'));
    check(res.status === 404 && /no longer there/.test(res.body?.error), "a link can't reach another seller's order", res.body?.error);
    res = await request('GET', '/api/act/garbage');
    check(res.status === 404, 'a made-up link is 404');

    const noScopeOrder = (await pool.query('SELECT id FROM orders WHERE seller_id = ?', [noScope]))[0][0].id;
    res = await request('GET', link(noScopeOrder, noScope, 'hold'));
    check(res.status === 200 && res.body.state.allowed === false && /Reconnect/.test(res.body.state.note), 'a store without the permission: the page says to reconnect', res.body?.state?.note);
    res = await request('POST', link(noScopeOrder, noScope, 'hold'), { fulfillment_order_id: '72010', reason: 'OTHER' });
    check(res.status === 409 && /Reconnect/.test(res.body?.error), 'and confirming is refused');

    console.log('\n3. Telegram');
    const orderC = await addOrder(seller, 7103);
    await pool.query("UPDATE orders SET risk_level = 'medium' WHERE id = ?", [orderC]);
    const heldSoFar = countCalls('hold');
    let t = await tap(`act:${orderC}:hold`);
    check(t.answer === 'Checking with Shopify…', 'a tap on "Hold in Shopify" is answered at once', t.answer);
    check(
      /^Put order #7103 on hold in Shopify\?\nReason: High risk of fraud\./.test(t.sent?.text || '') && t.sent.reply_to_message_id === 55,
      'and asks first, as a reply, with the reason',
      t.sent?.text
    );
    const confirmRow = t.sent?.reply_markup?.inline_keyboard?.[0]?.map((b) => b.callback_data);
    check(JSON.stringify(confirmRow) === JSON.stringify([`actok:${orderC}:hold:HIGH_RISK_OF_FRAUD`, `actno:${orderC}:hold`]), 'with Yes and Cancel', JSON.stringify(confirmRow));
    check(countCalls('hold') === heldSoFar, 'asking changes nothing in Shopify');

    t = await tap(`actno:${orderC}:hold`, { messageId: 77 });
    check(t.edited?.message_id === 77 && /^Cancelled\. Nothing was changed/.test(t.edited.text) && countCalls('hold') === heldSoFar, 'Cancel replaces the question and changes nothing', t.edited?.text);

    t = await tap(`act:${orderC}:hold`, { chat: 9999 });
    check(t.answer === "This chat can't act on that order." && !t.sent, "another chat's tap is refused");
    t = await tap(`actok:${orderC}:hold:OTHER`, { chat: 9999 });
    check(t.answer === "This chat can't act on that order." && countCalls('hold') === heldSoFar, "another chat can't confirm either");

    t = await tap(`actok:${orderC}:hold:HIGH_RISK_OF_FRAUD`, { messageId: 78 });
    check(t.answer === 'Asking Shopify…' && t.edited?.message_id === 78 && t.edited.text === 'Done: order #7103 is on hold in Shopify.', 'Yes puts it on hold and says so in place of the question', t.edited?.text);
    check(lastCall('hold')?.reason === 'HIGH_RISK_OF_FRAUD' && lastCall('hold').id === '71030', 'in Shopify, with that reason');
    log = await logFor(orderC);
    check(log.length === 1 && log[0].source === 'telegram' && log[0].reason === 'HIGH_RISK_OF_FRAUD', 'logged as done from Telegram', JSON.stringify(log));
    t = await tap(`actok:${orderC}:hold:HIGH_RISK_OF_FRAUD`, { messageId: 78 });
    check(/^Nothing was changed in Shopify: Shopify won't hold this now/.test(t.edited?.text || ''), 'a second Yes changes nothing, and says why', t.edited?.text);
    t = await tap(`act:${orderC}:hold`);
    check(/^Nothing to do for order #7103\. Shopify won't hold it now/.test(t.sent?.text || '') && !t.sent.reply_markup, 'a new tap on a held order says there is nothing to do', t.sent?.text);
    t = await tap('actok:abc:hold');
    check(t.answer === "This chat can't act on that order." && !t.edited, "made-up data isn't acted on", t.answer);

    const orderD = await addOrder(seller, 7104);
    t = await tap(`act:${orderD}:fulfill`);
    check(
      /^Mark order #7104 as fulfilled in Shopify\?\n2 items will be marked as shipped, with no tracking number, and Shopify emails the customer/.test(t.sent?.text || '') &&
        t.sent.text.includes(`https://ops.example.test/orders/${orderD}#in-shopify`),
      'a tap on "Mark fulfilled" asks first, saying what will happen and where to add tracking',
      t.sent?.text
    );
    t = await tap(`actok:${orderD}:fulfill`, { messageId: 79 });
    check(t.edited?.text === 'Done: order #7104 is marked fulfilled in Shopify.', 'Yes marks it fulfilled', t.edited?.text);
    check(lastCall('fulfill')?.id === '71040' && lastCall('fulfill').notifyCustomer === true && lastCall('fulfill').tracking === null, 'in Shopify, emailing the customer, no tracking');
    const [[shippedD]] = await pool.query('SELECT status FROM orders WHERE id = ?', [orderD]);
    log = await logFor(orderD);
    check(shippedD.status === 'fulfilled' && log[0]?.source === 'telegram' && log[0].action === 'fulfill', 'shown as fulfilled here, logged as from Telegram', JSON.stringify(log));

    const decisionD = { id: await addDecision(seller, orderD, '#7104', 'FULFILL - ok', 'fulfill') };
    const keyboard = [
      [{ text: 'Right call', callback_data: `rate:${decisionD.id}:up` }, { text: 'Wrong call', callback_data: `rate:${decisionD.id}:down` }],
      [{ text: 'Hold in Shopify', callback_data: `act:${orderD}:hold` }, { text: 'Mark fulfilled', callback_data: `act:${orderD}:fulfill` }],
    ];
    t = await tap(`rate:${decisionD.id}:up`, { keyboard });
    const after = t.markup?.reply_markup?.inline_keyboard?.map((row) => row.map((b) => b.text));
    check(JSON.stringify(after) === JSON.stringify([['✓ Right call', 'Wrong call'], ['Hold in Shopify', 'Mark fulfilled']]), 'rating from Telegram keeps the hold / fulfill buttons', JSON.stringify(after));
  } finally {
    server.close();
    smtp.server.close();
    tg.server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]); // line items and actions go with them
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]);
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
