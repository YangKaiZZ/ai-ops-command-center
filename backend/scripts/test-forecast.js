// End-to-end check of restock forecasts, run in-process with Shopify's order
// fetches replaced by a fake. The real database is used; the test sellers and
// their orders and items are removed at the end.
//   1. GET /api/inventory/forecast: pace, days left, reorder amount and
//      confidence per item, soonest first, with the history they're based on
//   2. what counts: refunded orders, orders before the lookback, custom items
//      and orders whose items we don't have yet don't
//   3. ?days= and ?cover_days=, and bad values
//   4. each seller sees only their own items and sales
//   5. an order sync fetches the items of older orders in the last 90 days, 100
//      ids at a time, and still succeeds when that fails
//
// Usage:  npm run test:forecast
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
const shopifyOrder = (id, placedDaysAgo, items, extra = {}) => ({
  id,
  name: `#${id}`,
  fulfillment_status: null,
  financial_status: 'paid',
  customer: { first_name: 'Ana', last_name: 'Smith' },
  total_price: '10.00',
  created_at: daysAgo(placedDaysAgo),
  line_items: items,
  ...extra,
});
let lineId = 1;
const line = (variantId, quantity) => ({ id: lineId++, variant_id: variantId, title: `Variant ${variantId}`, quantity, price: '1.00' });

async function main() {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET, encryptSecret } = require('../src/config/secrets');
  const { upsertOrder } = require('../src/models/orderModel');
  const shopifyService = require('../src/services/shopifyService');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];

  // The fake Shopify. No new orders; older orders are returned by id if listed in `shopifyHas`.
  const byIdCalls = [];
  let shopifyHas = new Map();
  let byIdFails = false;
  shopifyService.fetchOrders = async () => [];
  shopifyService.fetchOrdersByIds = async (shopDomain, accessToken, ids) => {
    byIdCalls.push({ shopDomain, accessToken, ids });
    if (byIdFails) throw new Error('socket hang up');
    return ids.filter((id) => shopifyHas.has(id)).map((id) => shopifyHas.get(id));
  };

  const addSeller = async (name) => {
    const [r] = await pool.query(
      "INSERT INTO sellers (business_name, email, password_hash, shopify_shop_domain, shopify_access_token) VALUES (?, ?, 'x', ?, ?)",
      [name, `fc-${run}-${name}@example.test`, `fc-${run}-${name}.myshopify.com`, encryptSecret('shpat_fake_token')]
    );
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  const addItem = (sellerId, variantId, name, stock, threshold = 5) =>
    pool.query(
      `INSERT INTO inventory_items (seller_id, shopify_product_id, shopify_variant_id, item_name, stock_quantity, low_stock_threshold)
       VALUES (?, '1', ?, ?, ?, ?)`,
      [sellerId, String(variantId), name, stock, threshold]
    );
  // An order as it was saved before line items were kept.
  const addBareOrder = async (sellerId, shopifyId, placedDaysAgo) =>
    pool.query(
      `INSERT INTO orders (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at)
       VALUES (?, ?, ?, 'unfulfilled', 'paid', 'Old Buyer', 5.00, NOW() - INTERVAL ? DAY)`,
      [sellerId, String(shopifyId), `#${shopifyId}`, placedDaysAgo]
    );
  const tokenFor = (sellerId) => jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' });
  const call = async (method, route, sellerId) => {
    const headers = sellerId ? { Authorization: `Bearer ${tokenFor(sellerId)}` } : {};
    const res = await fetch(base + route, { method, headers });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const forecast = async (sellerId, query = '') => call('GET', `/api/inventory/forecast${query}`, sellerId);
  const itemNamed = (body, name) => body?.items?.find((i) => i.item_name === name) || {};

  try {
    const seller = await addSeller('main');
    await addItem(seller, 5001, 'Mug', 10);
    await addItem(seller, 5002, 'Scarf', 0, 3);
    await addItem(seller, 5003, 'Poster', 50);
    await addItem(seller, 5004, 'Candle', 4);

    // The store's first order, before the 30-day lookback: history is a full 30 days.
    await upsertOrder(seller, shopifyOrder(8001, 60, [line(5004, 5)]));
    // 12 mugs over 3 orders, 6 scarves over 2, a custom item (no variant).
    await upsertOrder(seller, shopifyOrder(8002, 20, [line(5001, 4)]));
    await upsertOrder(seller, shopifyOrder(8003, 10, [line(5001, 4), line(5002, 3)]));
    await upsertOrder(seller, shopifyOrder(8004, 5, [line(5001, 4), line(5002, 3), { ...line(null, 1), title: 'Gift wrap' }]));
    // Refunded: its candles don't count.
    await upsertOrder(seller, shopifyOrder(8005, 3, [line(5004, 10)], { financial_status: 'refunded' }));
    // Saved before line items were kept: 7777 is still in Shopify, 7778 was deleted there, 7779 is older than 90 days.
    await addBareOrder(seller, 7778, 3);
    await addBareOrder(seller, 7777, 2);
    await addBareOrder(seller, 7779, 100);

    console.log('\n1. The forecast');
    let res = await forecast(seller);
    const f = res.body || {};
    check(res.status === 200 && f.lookback_days === 30 && f.cover_days === 30, 'defaults: 30 days of sales, reorder for 30 days', `${res.status}`);
    check(f.history?.days === 30 && Math.abs(Date.parse(f.history.from) - (Date.now() - 30 * DAY)) < 60000, 'history: the full 30 days (the first order is older)', JSON.stringify(f.history));
    check(f.history?.orders === 3 && f.history.orders_missing_items === 2, 'orders counted, and in-window orders whose items are missing', `${f.history?.orders} counted, ${f.history?.orders_missing_items} missing`);
    const mug = itemNamed(f, 'Mug');
    check(mug.units_sold === 12 && mug.orders === 3 && mug.per_day === 0.4, 'Mug: 12 sold in 3 orders, 0.4 a day', JSON.stringify(mug));
    check(mug.days_left === 25 && Math.abs(Date.parse(mug.runs_out_at) - (Date.now() + 25 * DAY)) < 60000, 'Mug: 10 in stock lasts 25 days', `${mug.days_left} days, ${mug.runs_out_at}`);
    check(mug.reorder_quantity === 2 && mug.confidence === 'normal', 'Mug: reorder 2 for 30 days, normal confidence', `${mug.reorder_quantity}, ${mug.confidence}`);
    const scarf = itemNamed(f, 'Scarf');
    check(scarf.days_left === 0 && scarf.runs_out_at === null && scarf.reorder_quantity === 6, 'Scarf: out of stock, reorder 6', JSON.stringify(scarf));
    check(scarf.confidence === 'low', 'Scarf: 2 orders is low confidence');
    check(scarf.stock_quantity === 0 && scarf.low_stock_threshold === 3 && scarf.shopify_variant_id === '5002', 'items carry their stock, threshold and variant id');
    check(f.items?.map((i) => i.item_name).join() === 'Scarf,Mug,Candle,Poster', 'soonest to run out first, items not selling last', f.items?.map((i) => i.item_name).join());

    console.log('\n2. What counts');
    const candle = itemNamed(f, 'Candle');
    check(candle.units_sold === 0 && candle.days_left === null && candle.reorder_quantity === 0, 'refunded orders and orders before the lookback don\'t', JSON.stringify(candle));
    check(itemNamed(f, 'Poster').per_day === 0, 'an item with no sales sells 0 a day');
    check(f.items?.length === 4, 'custom items aren\'t forecast (only tracked stock is)', String(f.items?.length));

    console.log('\n3. Options');
    res = await forecast(seller, '?days=7&cover_days=60');
    const week = itemNamed(res.body, 'Mug');
    check(res.status === 200 && res.body.history.days === 7 && res.body.history.orders === 1, 'days=7: only the last week', JSON.stringify(res.body?.history));
    check(week.units_sold === 4 && week.per_day === 0.57 && week.confidence === 'low', 'Mug over a week: 4 sold, 0.57 a day, low confidence', JSON.stringify(week));
    check(week.reorder_quantity === 25, 'cover_days=60: reorder 60 days\' worth minus stock (34.3 - 10 -> 25)', String(week.reorder_quantity));
    for (const [query, pattern] of [
      ['?days=0', /days must be a whole number of days from 1 to 90/],
      ['?days=91', /from 1 to 90/],
      ['?cover_days=abc', /cover_days must be a whole number of days from 1 to 180/],
    ]) {
      res = await forecast(seller, query);
      check(res.status === 400 && pattern.test(res.body?.error), `${query} is refused`, res.body?.error);
    }
    res = await forecast(null);
    check(res.status === 401, 'signed out: 401', String(res.status));

    console.log('\n4. Each seller\'s own');
    const other = await addSeller('other');
    await addItem(other, 5001, 'Other mug', 30); // same variant id as the main seller's Mug
    await upsertOrder(other, shopifyOrder(8101, 1, [line(5001, 100)]));
    res = await forecast(other);
    check(res.body?.items?.length === 1 && res.body.items[0].item_name === 'Other mug' && res.body.items[0].units_sold === 100, 'another seller sees only their item and sales', JSON.stringify(res.body?.items));
    check(res.body?.history?.days === 1 && res.body.items[0].confidence === 'low', 'their history is 1 day (their first order), so low confidence', JSON.stringify(res.body?.history));
    res = await forecast(seller);
    check(itemNamed(res.body, 'Mug').units_sold === 12, 'and the main seller\'s Mug is unchanged');
    const empty = await addSeller('empty');
    await addItem(empty, 6001, 'Unsold', 3);
    res = await forecast(empty);
    check(res.status === 200 && res.body.history.from === null && res.body.history.days === 0 && res.body.items[0].days_left === null, 'no orders at all: no history, no run-out date', JSON.stringify(res.body?.history));

    console.log('\n5. The order sync fetches older orders\' items');
    shopifyHas = new Map([['7777', shopifyOrder(7777, 2, [line(5001, 6)])]]);
    res = await call('POST', '/api/orders/sync', seller);
    check(res.status === 200 && /fetched the items of 1 older ones/.test(res.body?.message), 'the sync says how many it filled in', res.body?.message);
    check(byIdCalls.length === 1 && byIdCalls[0].ids.join() === '7778,7777' && byIdCalls[0].accessToken === 'shpat_fake_token', 'one request for the in-window orders, oldest first, with the store\'s token', JSON.stringify(byIdCalls[0]?.ids));
    res = await forecast(seller);
    check(itemNamed(res.body, 'Mug').units_sold === 18 && res.body.history.orders === 4, 'their sales now count (12 + 6 mugs)', `${itemNamed(res.body, 'Mug').units_sold} mugs, ${res.body?.history?.orders} orders`);
    check(res.body?.history?.orders_missing_items === 1, 'the order deleted in Shopify is still missing its items', String(res.body?.history?.orders_missing_items));
    await call('POST', '/api/orders/sync', seller);
    check(byIdCalls.length === 2 && byIdCalls[1].ids.join() === '7778', 'the next sync asks only about that one', JSON.stringify(byIdCalls[1]?.ids));

    byIdFails = true;
    res = await call('POST', '/api/orders/sync', seller);
    check(res.status === 200 && /^Synced 0 new or updated orders$/.test(res.body?.message), 'Shopify failing on those: the sync still succeeds', `${res.status} ${res.body?.message}`);
    byIdFails = false;

    const many = await addSeller('many');
    const values = Array.from({ length: 101 }, (_, i) => `(${many}, '${9000 + i}', '#${9000 + i}', 'fulfilled', 'paid', 'Old Buyer', 1.00, NOW() - INTERVAL 1 DAY)`);
    await pool.query(
      `INSERT INTO orders (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at) VALUES ${values.join(',')}`
    );
    const before = byIdCalls.length;
    res = await call('POST', '/api/orders/sync', many);
    const sizes = byIdCalls.slice(before).map((c) => c.ids.length).join();
    check(res.status === 200 && sizes === '100,1', '101 older orders: two requests, 100 then 1', sizes);
  } finally {
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]); // line items go with them
      await pool.query('DELETE FROM inventory_items WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]);
    }
    console.log('\nRemoved the test sellers, their orders and items.');
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
