// End-to-end check of the Overview endpoint, run in-process against the real
// database with throwaway sellers (removed at the end):
//   1. the default period (last 7 days) and the 7 days before it: order
//      counts, sales without refunded/voided orders, what needs action, the
//      oldest unshipped order, stock counts, what runs out soon, decisions
//   2. a period starting at ?from=, and bad values
//   3. each seller sees only their own numbers; a new seller sees zeros
//
// Usage:  npm run test:overview
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

const DAY = 24 * 60 * 60 * 1000;
// Shopify sends an offset (MySQL doesn't take a "Z").
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().replace(/\.\d{3}Z$/, '+00:00');
let nextId = 1;
const shopifyOrder = (placedDaysAgo, fulfillment, payment, total, items = []) => {
  const id = nextId++;
  return {
    id: 880000 + id,
    name: `#${880000 + id}`,
    fulfillment_status: fulfillment,
    financial_status: payment,
    customer: null,
    total_price: total,
    created_at: daysAgo(placedDaysAgo),
    line_items: items.map(([variantId, quantity], i) => ({ id: id * 100 + i, variant_id: variantId, title: 'x', quantity, price: '1.00' })),
  };
};

async function main() {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../src/config/secrets');
  const { upsertOrder } = require('../src/models/orderModel');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];

  const addSeller = async (name) => {
    const [r] = await pool.query("INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, 'x')", [
      name,
      `ov-${run}-${name}@example.test`,
    ]);
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  const addItem = (sellerId, variantId, name, stock, threshold) =>
    pool.query(
      `INSERT INTO inventory_items (seller_id, shopify_product_id, shopify_variant_id, item_name, stock_quantity, low_stock_threshold)
       VALUES (?, '1', ?, ?, ?, ?)`,
      [sellerId, String(variantId), name, stock, threshold]
    );
  const addDecision = (sellerId, action, daysBack) =>
    pool.query(
      "INSERT INTO decisions (seller_id, reasoning, action_taken, created_at) VALUES (?, 'test', ?, NOW() - INTERVAL ? MINUTE)",
      [sellerId, action, Math.round(daysBack * 24 * 60)]
    );
  const get = async (route, sellerId) => {
    const headers = sellerId ? { Authorization: `Bearer ${jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' })}` } : {};
    const res = await fetch(base + route, { headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  try {
    const seller = await addSeller('main');
    await addItem(seller, 1, 'Mug', 3, 5); // low, sells 1 a day: runs out in 3 days
    await addItem(seller, 2, 'Scarf', 0, 2); // out of stock
    await addItem(seller, 3, 'Poster', 100, 5); // plenty
    await addItem(seller, 4, 'Candle', 8, 5); // only sold in a refunded order

    // This week (the last 7 days)
    const a = await upsertOrder(seller, shopifyOrder(1, 'fulfilled', 'paid', '100.00', [[1, 10]]));
    const b = await upsertOrder(seller, shopifyOrder(2, null, 'paid', '50.50', [[3, 5]])); // needs action
    await upsertOrder(seller, shopifyOrder(3, 'fulfilled', 'refunded', '30.00', [[4, 20]])); // counted, no sales
    const d = await upsertOrder(seller, shopifyOrder(6, null, 'pending', '20.00')); // needs action
    // The 7 days before
    await upsertOrder(seller, shopifyOrder(9, 'fulfilled', 'paid', '40.00', [[1, 10]]));
    await upsertOrder(seller, shopifyOrder(10, null, 'voided', '99.00')); // counted, no sales, no action
    const g = await upsertOrder(seller, shopifyOrder(12, 'partial', 'paid', '10.00')); // needs action, oldest unshipped
    // Earlier: the store's first order, so forecasts have 20 days of history.
    await upsertOrder(seller, shopifyOrder(20, 'fulfilled', 'paid', '5.00', [[2, 2]]));

    await addDecision(seller, 'fulfill', 1);
    await addDecision(seller, 'fulfill', 1.5);
    await addDecision(seller, 'hold', 3);
    await addDecision(seller, 'skipped', 5);
    await addDecision(seller, 'low_stock_alert', 10); // before the period

    console.log('\n1. The last 7 days');
    let res = await get('/api/overview', seller);
    const o = res.body || {};
    check(res.status === 200 && o.period?.days === 7, 'a 7-day period by default', `${res.status} ${JSON.stringify(o.period)}`);
    check(o.orders?.count === 4 && o.orders.sales === '170.50', 'orders and sales this period (refunded left out of sales)', `${o.orders?.count} orders, ${o.orders?.sales}`);
    check(o.orders?.previous_count === 3 && o.orders.previous_sales === '50.00', 'and in the 7 days before (voided left out of sales)', `${o.orders?.previous_count} orders, ${o.orders?.previous_sales}`);
    check(o.orders?.needs_action === 3, 'orders that need action, at any time', String(o.orders?.needs_action));
    check(o.orders?.oldest_unshipped?.id === g && o.orders.oldest_unshipped.order_number === '#880007', 'the oldest unshipped order (not the voided one)', JSON.stringify(o.orders?.oldest_unshipped));
    check([a, b, d].every(Boolean), 'orders were saved');
    const s = o.stock || {};
    check(s.tracked === 4 && s.low === 2 && s.out_of_stock === 1, 'stock: tracked, low (out of stock included), out of stock', JSON.stringify({ tracked: s.tracked, low: s.low, out: s.out_of_stock }));
    check(s.to_reorder === 2, 'items to reorder, as on the Reorder tab (Mug and Scarf)', String(s.to_reorder));
    check(s.running_out?.length === 1 && s.running_out[0].item_name === 'Mug' && s.running_out[0].days_left === 3 && s.running_out[0].reorder_quantity === 27, 'runs out within 7 days: the Mug, in 3 days, reorder 27', JSON.stringify(s.running_out));
    check(s.running_out_within_days === 7 && s.forecast?.history?.days === 20 && s.forecast.lookback_days === 30, 'with what the forecasts are based on', JSON.stringify(s.forecast?.history));
    check(
      JSON.stringify({ ...o.decisions, ratings: undefined }) === JSON.stringify({ fulfill: 2, hold: 1, low_stock_alert: 0, unknown: 0, skipped: 1, total: 4 }) &&
        o.decisions.ratings?.unrated === 3 &&
        o.decisions.ratings.up === 0,
      'agent decisions this period, by verdict, none rated yet (test:decision-feedback rates them)',
      JSON.stringify(o.decisions)
    );

    console.log('\n2. Another period');
    const from = new Date(Date.now() - 2 * DAY + 60 * 60 * 1000).toISOString();
    res = await get(`/api/overview?from=${encodeURIComponent(from)}`, seller);
    check(res.status === 200 && res.body.period.from === from && res.body.period.days === 2, 'from= sets the start', JSON.stringify(res.body?.period));
    check(res.body?.orders?.count === 1 && res.body.orders.sales === '100.00', 'only orders since then', `${res.body?.orders?.count}, ${res.body?.orders?.sales}`);
    check(res.body?.orders?.previous_count === 2 && res.body.orders.previous_sales === '50.50', 'compared with the same length of time before', `${res.body?.orders?.previous_count}, ${res.body?.orders?.previous_sales}`);
    check(res.body?.decisions?.total === 2 && res.body.decisions.fulfill === 2, 'decisions since then', JSON.stringify(res.body?.decisions));
    check(res.body?.orders?.needs_action === 3 && res.body.stock.to_reorder === 2, 'what needs doing doesn\'t depend on the period');
    for (const bad of ['2026-09-20', 'yesterday', new Date(Date.now() + DAY).toISOString(), new Date(Date.now() - 40 * DAY).toISOString()]) {
      res = await get(`/api/overview?from=${encodeURIComponent(bad)}`, seller);
      check(res.status === 400 && /within the last 31 days/.test(res.body?.error), `from=${bad} is refused`, res.body?.error);
    }
    res = await get('/api/overview', null);
    check(res.status === 401, 'signed out: 401', String(res.status));

    console.log('\n3. Each seller\'s own');
    const other = await addSeller('other');
    await upsertOrder(other, shopifyOrder(1, null, 'paid', '999.00'));
    res = await get('/api/overview', other);
    check(res.body?.orders?.count === 1 && res.body.orders.sales === '999.00' && res.body.orders.needs_action === 1, 'another seller sees only their order', JSON.stringify(res.body?.orders));
    check(res.body?.stock?.tracked === 0 && res.body.decisions.total === 0, 'and none of the main seller\'s stock or decisions');
    const empty = await addSeller('empty');
    res = await get('/api/overview', empty);
    const e = res.body || {};
    check(
      res.status === 200 && e.orders.count === 0 && e.orders.sales === '0.00' && e.orders.previous_sales === '0.00' && e.orders.oldest_unshipped === null,
      'a new seller: zeros, no oldest order',
      JSON.stringify(e.orders)
    );
    check(e.stock?.running_out?.length === 0 && e.stock.forecast.history.from === null && e.decisions.total === 0, 'no forecasts, no decisions');
  } finally {
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]); // line items go with them
      await pool.query('DELETE FROM inventory_items WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]);
    }
    console.log('\nRemoved the test sellers and their orders, items and decisions.');
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
