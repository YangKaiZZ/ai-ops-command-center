// End-to-end check of order paging and filters, through the REST API and
// through the MCP tools (connected the way the agent connects). Runs
// in-process on a throwaway seller with 55 orders; they are removed at the end.
//   1. /api/orders pages newest first, with a total; pages don't overlap
//   2. filters: fulfillment status, payment status, UTC date range, order number,
//      search by part of a number or name, needs action
//   3. each order carries the agent's latest decision
//   4. bad input gets a 400 that says what to fix
//   5. /api/orders/pending pages oldest first, with a total
//   6. another seller's orders never show up
//   7. MCP tools: pages with total/next_offset, filters, get_order, input checks
//
// Usage:  npm run test:order-queries
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.MCP_SERVER_PATH = path.join(__dirname, '..', '..', 'mcp', 'server.js');

const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

const COUNT = 55;
// Order i: #2000+i, placed 2026-08-01 + floor(i/5) days at 10:00+i%5 UTC.
// i%3: 0 fulfilled+paid, 1 unfulfilled+paid, 2 unfulfilled+pending.
const placedAt = (i) => Date.UTC(2026, 7, 1 + Math.floor(i / 5), 10 + (i % 5)) / 1000;
// Buyers: every 5th is Ana Smith, #2013 has a % in its name, the rest Test Buyer.
const buyer = (i) => (i % 5 === 0 ? 'Ana Smith' : i === 13 ? 'Promo 50%_Off' : 'Test Buyer');
const kind = (i) => [['fulfilled', 'paid'], ['unfulfilled', 'paid'], ['unfulfilled', 'pending']][i % 3];

async function main() {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../src/config/secrets');
  const { connectAsSeller } = require('../src/services/mcpClient');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  process.env.PORT = String(server.address().port); // where the MCP server reaches the backend
  const base = `http://localhost:${server.address().port}`;
  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];

  const addSeller = async (name) => {
    const [r] = await pool.query("INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, 'x')", [name, `oq-${run}-${name}@example.test`]);
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  const addOrder = async (sellerId, i) => {
    const [status, financial] = kind(i);
    const [r] = await pool.query(
      `INSERT INTO orders (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at)
       VALUES (?, ?, ?, ?, ?, ?, 10.00, FROM_UNIXTIME(?))`,
      [sellerId, `oq-${run}-${sellerId}-${i}`, `#${2000 + i}`, status, financial, buyer(i), placedAt(i)]
    );
    return r.insertId;
  };

  try {
    const seller = await addSeller('main');
    const ids = [];
    for (let i = 0; i < COUNT; i++) ids.push(await addOrder(seller, i));
    await pool.query(
      `INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken, created_at) VALUES
       (?, ?, '#2007', 'HOLD - older decision', 'hold', NOW() - INTERVAL 1 HOUR),
       (?, ?, '#2007', 'FULFILL - stock confirmed for every line item', 'fulfill', NOW())`,
      [seller, ids[7], seller, ids[7]]
    );
    const other = await addSeller('other');
    await addOrder(other, 0);

    const token = jwt.sign({ sellerId: seller }, JWT_SECRET, { expiresIn: '10m' });
    const get = async (route) => {
      const res = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    };
    const numbers = (orders) => orders.map((o) => o.order_number);

    console.log('\n1. Pages');
    let res = await get('/api/orders');
    check(res.status === 200 && res.body.total === COUNT && res.body.orders.length === 50, 'no query: first 50 of 55', `${res.body.orders?.length} of ${res.body.total}`);
    check(res.body.orders[0].order_number === '#2054' && res.body.orders[49].order_number === '#2005', 'newest first', `${res.body.orders[0].order_number} .. ${res.body.orders[49].order_number}`);
    check(!('seller_id' in res.body.orders[0]), 'rows leave out seller_id');
    const firstPage = res.body.orders.map((o) => o.id);
    res = await get('/api/orders?limit=50&offset=50');
    check(res.body.orders.length === 5 && res.body.offset === 50, 'the second page has the last 5', numbers(res.body.orders).join(' '));
    check(new Set([...firstPage, ...res.body.orders.map((o) => o.id)]).size === COUNT, 'pages cover every order once');
    res = await get('/api/orders?limit=10&offset=100');
    check(res.body.orders.length === 0 && res.body.total === COUNT, 'past the end: empty page, same total');

    console.log('\n2. Filters');
    res = await get('/api/orders?status=fulfilled&limit=1');
    check(res.body.total === 19, 'status=fulfilled', String(res.body.total));
    res = await get('/api/orders?financial_status=pending&status=unfulfilled');
    check(res.body.total === 18 && res.body.orders.every((o) => o.financial_status === 'pending'), 'financial_status=pending with status', String(res.body.total));
    res = await get('/api/orders?from=2026-08-03&to=2026-08-03');
    check(res.body.total === 5 && numbers(res.body.orders).join() === '#2014,#2013,#2012,#2011,#2010', 'one UTC day, whole day included', numbers(res.body.orders).join(' '));
    res = await get('/api/orders?from=2026-08-10');
    check(res.body.total === 10, 'from a day on', String(res.body.total));
    res = await get(`/api/orders?to=${encodeURIComponent('2026-08-01T11:00:00Z')}`);
    check(res.body.total === 2, 'up to an exact time', numbers(res.body.orders).join(' '));
    for (const n of ['2007', '%232007']) {
      res = await get(`/api/orders?number=${n}`);
      check(res.body.total === 1 && res.body.orders[0].order_number === '#2007', `number=${decodeURIComponent(n)} finds #2007`);
    }
    const byNumber = res;
    res = await get('/api/orders?q=smith');
    check(res.body.total === 11 && res.body.orders.every((o) => o.buyer_name === 'Ana Smith'), 'q=smith: part of a name, any case', String(res.body.total));
    res = await get('/api/orders?q=205');
    check(res.body.total === 5 && numbers(res.body.orders).join() === '#2054,#2053,#2052,#2051,#2050', 'q=205: part of an order number', numbers(res.body.orders).join(' '));
    res = await get(`/api/orders?q=${encodeURIComponent('%')}`);
    check(res.body.total === 1 && res.body.orders[0].order_number === '#2013', 'q=%: a literal %, not a wildcard', String(res.body.total));
    res = await get('/api/orders?needs_action=true&limit=1');
    check(res.body.total === 36, 'needs_action=true: same rule as the pending list', String(res.body.total));
    res = await get('/api/orders?needs_action=true&q=smith');
    check(res.body.total === 7 && numbers(res.body.orders)[0] === '#2050', 'filters combine, still newest first', `${res.body.total}: ${numbers(res.body.orders).join(' ')}`);

    console.log('\n3. Latest decision');
    const d = byNumber.body.orders[0].latest_decision;
    check(d?.action_taken === 'fulfill' && /stock confirmed/.test(d.reasoning), 'the newest of two decisions', d?.action_taken);
    res = await get('/api/orders?number=2008');
    check(res.body.orders[0].latest_decision === null, 'null when the agent hasn\'t decided');

    console.log('\n4. Bad input');
    for (const [q, pattern] of [['limit=500', /limit must be/], ['offset=-1', /offset must be/], ['status=shipped', /status must be one of/], ['from=last-week', /from must be a date/], ['from=2026-09-02&to=2026-09-01', /from must not be after to/], ['needs_action=yes', /true or false/], [`q=${'x'.repeat(101)}`, /at most 100/]]) {
      res = await get(`/api/orders?${q}`);
      check(res.status === 400 && pattern.test(res.body.error), q, res.body.error);
    }

    console.log('\n5. Pending');
    res = await get('/api/orders/pending?limit=5');
    check(res.body.total === 36 && res.body.pending_orders.length === 5, '36 need action, 5 returned', `${res.body.pending_orders.length} of ${res.body.total}`);
    check(numbers(res.body.pending_orders).join() === '#2001,#2002,#2004,#2005,#2007', 'oldest first, fulfilled+paid left out', numbers(res.body.pending_orders).join(' '));

    console.log('\n6. Other sellers');
    res = await get('/api/orders?limit=200');
    check(res.body.total === COUNT && res.body.orders.every((o) => ids.includes(o.id)), 'only this seller\'s orders');

    console.log('\n7. MCP tools');
    const mcp = await connectAsSeller(seller);
    try {
      const names = mcp.tools.map((t) => t.name);
      check(names.includes('get_order') && !names.includes('sync_latest_data'), 'the agent gets get_order, not sync', names.join(', '));
      const all = mcp.tools.find((t) => t.name === 'get_all_orders');
      check(['limit', 'offset', 'status', 'financial_status', 'from', 'to'].every((k) => k in (all.inputSchema.properties || {})), 'get_all_orders advertises its inputs');

      const call = async (name, args) => {
        const r = await mcp.callTool(name, args);
        return { ...r, json: r.isError ? null : (() => { try { return JSON.parse(r.text); } catch { return null; } })() };
      };
      let r = await call('get_all_orders', {});
      check(r.json?.total === COUNT && r.json.returned === 20 && r.json.next_offset === 20, 'no inputs: 20 of 55, next_offset 20', `${r.text.length} chars`);
      const row = r.json?.orders[0] || {};
      check(!('synced_at' in row) && 'latest_decision' in row, 'rows are trimmed, with the verdict');
      r = await call('get_all_orders', { offset: 40 });
      check(r.json?.returned === 15 && r.json.next_offset === null, 'the last page: next_offset null');
      const withDecision = r.json?.orders.find((o) => o.order_number === '#2007');
      check(withDecision?.latest_decision?.verdict === 'fulfill' && !('reasoning' in withDecision.latest_decision), 'lists carry the verdict without the reasoning');
      r = await call('get_all_orders', { status: 'fulfilled', limit: 1 });
      check(r.json?.total === 19 && r.json.returned === 1, 'a count with limit 1', String(r.json?.total));
      r = await call('get_all_orders', { from: '2026-08-03', to: '2026-08-03' });
      check(r.json?.total === 5, 'a date range', String(r.json?.total));
      r = await call('get_pending_orders', { limit: 5 });
      check(r.json?.total === 36 && r.json.returned === 5 && r.json.orders[0].order_number === '#2001', 'get_pending_orders pages oldest first');
      r = await call('get_order', { order_number: '#2007' });
      check(r.json?.order_number === '#2007' && /stock confirmed/.test(r.json.latest_decision?.reasoning), 'get_order includes the reasoning');
      r = await call('get_order', { order_number: '9999' });
      check(!r.isError && /No order 9999/.test(r.text), 'an unknown number says so', r.text);
      r = await call('get_all_orders', { limit: 500 });
      check(r.isError, 'limit over 100 is refused before reaching the API', r.text.slice(0, 80));
      r = await call('get_all_orders', { from: 'last week' });
      check(r.isError, 'a date that isn\'t YYYY-MM-DD is refused', r.text.slice(0, 80));
    } finally {
      await mcp.close();
    }
  } finally {
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]);
    }
    console.log('\nRemoved the test sellers and their orders.');
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
