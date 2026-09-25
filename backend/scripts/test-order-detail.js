// End-to-end check of order line items and the order detail endpoint, run
// in-process with Shopify's single-order fetch replaced by a fake. The real
// database is used; the test sellers and their orders are removed at the end.
//   1. saving an order stores its line items; a later payload replaces them;
//      a payload without line_items leaves them alone
//   2. GET /api/orders/:id: fields, line items, every decision newest first, Shopify link
//   3. orders saved before line items were kept are fetched from Shopify once
//   4. when that can't happen (order gone, Shopify down, store not connected) the order still loads, with a note
//   5. another seller's order, and a non-numeric id, are 404
//
// Usage:  npm run test:order-detail
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

const shopifyOrder = (id, items, extra = {}) => ({
  id,
  name: `#${id}`,
  fulfillment_status: null,
  financial_status: 'paid',
  customer: { first_name: 'Ana', last_name: 'Smith' },
  total_price: '100.00',
  created_at: '2026-08-01T10:00:00-04:00', // Shopify sends an offset
  line_items: items,
  ...extra,
});
const item = (id, title, quantity, extra = {}) => ({ id, variant_id: id + 1000, title, variant_title: 'Default', sku: `SKU-${id}`, quantity, fulfillable_quantity: quantity, price: '10.00', ...extra });

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
  const shop = `od-${run}.myshopify.com`;
  const sellerIds = [];

  // The fake Shopify: what fetchOrder returns, and who asked.
  const fetched = [];
  let shopifyReply = () => null;
  shopifyService.fetchOrder = async (shopDomain, accessToken, orderId) => {
    fetched.push({ shopDomain, accessToken, orderId });
    return shopifyReply(orderId);
  };

  const addSeller = async (name, connected) => {
    const [r] = await pool.query(
      "INSERT INTO sellers (business_name, email, password_hash, shopify_shop_domain, shopify_access_token) VALUES (?, ?, 'x', ?, ?)",
      [name, `od-${run}-${name}@example.test`, connected ? shop : null, connected ? encryptSecret('shpat_fake_token') : null]
    );
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  // An order as it was saved before line items were kept.
  const addBareOrder = async (sellerId, shopifyId) => {
    const [r] = await pool.query(
      `INSERT INTO orders (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at)
       VALUES (?, ?, ?, 'unfulfilled', 'pending', 'Old Buyer', 5.00, NOW())`,
      [sellerId, String(shopifyId), `#${shopifyId}`]
    );
    return r.insertId;
  };
  const tokenFor = (sellerId) => jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' });
  const get = async (route, sellerId) => {
    const res = await fetch(base + route, { headers: { Authorization: `Bearer ${tokenFor(sellerId)}` } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const itemsOf = async (orderId) =>
    (await pool.query('SELECT shopify_line_item_id AS id, title, quantity FROM order_line_items WHERE order_id = ? ORDER BY id', [orderId]))[0];

  try {
    const seller = await addSeller('main', true);

    console.log('\n1. Saving line items');
    const orderId = await upsertOrder(seller, shopifyOrder(9001, [item(1, 'Linen shirt', 2, { properties: [{ name: 'Note', value: 'private' }] }), item(2, 'Canvas bag', 1)]));
    let items = await itemsOf(orderId);
    check(items.length === 2 && items[0].title === 'Linen shirt' && items[0].quantity === 2, 'a new order stores its items', items.map((i) => `${i.quantity}x ${i.title}`).join(', '));
    const [[{ synced }]] = await pool.query('SELECT line_items_synced_at IS NOT NULL AS synced FROM orders WHERE id = ?', [orderId]);
    check(synced === 1, 'and records when');
    const sameId = await upsertOrder(seller, shopifyOrder(9001, [item(1, 'Linen shirt', 3)], { fulfillment_status: 'partial' }));
    items = await itemsOf(orderId);
    check(sameId === orderId, 'saving it again returns the same order id', `${sameId} / ${orderId}`);
    check(items.length === 1 && items[0].quantity === 3, 'a later payload replaces the items (an order edit)', items.map((i) => `${i.quantity}x ${i.title}`).join(', '));
    await upsertOrder(seller, shopifyOrder(9001, undefined, { fulfillment_status: 'partial' }));
    check((await itemsOf(orderId)).length === 1, 'a payload without line_items leaves them alone');

    console.log('\n2. The detail endpoint');
    await pool.query(
      `INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken, created_at) VALUES
       (?, ?, '#9001', 'HOLD - waiting on stock', 'hold', NOW() - INTERVAL 1 HOUR),
       (?, ?, '#9001', 'FULFILL - stock arrived', 'fulfill', NOW())`,
      [seller, orderId, seller, orderId]
    );
    let res = await get(`/api/orders/${orderId}`, seller);
    const detail = res.body || {};
    check(res.status === 200 && detail.order?.order_number === '#9001' && detail.order.status === 'partial', 'the order with its current status', `${res.status} ${detail.order?.status}`);
    check(!('seller_id' in (detail.order || {})) && !('line_items_synced_at' in (detail.order || {})), 'internal columns left out');
    check(detail.line_items?.length === 1 && detail.line_items[0].sku === 'SKU-1' && detail.line_items[0].fulfillable_quantity === 3, 'its line items', JSON.stringify(detail.line_items?.[0]));
    check(detail.decisions?.map((d) => d.action_taken).join() === 'fulfill,hold', 'every decision, newest first');
    check(detail.shopify_admin_url === `https://${shop}/admin/orders/9001`, 'a link to it in the Shopify admin', detail.shopify_admin_url);
    check(fetched.length === 0, 'no Shopify call for an order that has its items');

    console.log('\n3. Older orders fetch their items once');
    const old = await addBareOrder(seller, 9002);
    shopifyReply = (id) => shopifyOrder(Number(id), [item(5, 'Wool scarf', 4)], { fulfillment_status: 'fulfilled' });
    res = await get(`/api/orders/${old}`, seller);
    check(res.status === 200 && res.body.line_items?.[0]?.title === 'Wool scarf' && res.body.line_items_note === null, 'the first view fetches them from Shopify', JSON.stringify(res.body.line_items));
    check(fetched.length === 1 && fetched[0].orderId === '9002' && fetched[0].shopDomain === shop && fetched[0].accessToken === 'shpat_fake_token', 'with the store\'s own (decrypted) token');
    check(res.body.order.status === 'fulfilled', 'and picks up the current status too', res.body.order.status);
    await get(`/api/orders/${old}`, seller);
    check(fetched.length === 1, 'the second view doesn\'t ask again');

    console.log('\n4. When they can\'t be fetched');
    const gone = await addBareOrder(seller, 9003);
    shopifyReply = () => null;
    res = await get(`/api/orders/${gone}`, seller);
    check(res.status === 200 && res.body.line_items === null && /no longer has this order/.test(res.body.line_items_note), 'deleted in Shopify: a note', res.body.line_items_note);
    const flaky = await addBareOrder(seller, 9004);
    shopifyReply = () => {
      throw new Error('socket hang up');
    };
    res = await get(`/api/orders/${flaky}`, seller);
    check(res.status === 200 && res.body.line_items === null && /Try again/.test(res.body.line_items_note), 'Shopify failing: the order still loads, with a note', res.body.line_items_note);
    shopifyReply = (id) => shopifyOrder(Number(id), [item(6, 'Candle', 1)]);
    res = await get(`/api/orders/${flaky}`, seller);
    check(res.body.line_items?.length === 1, 'and the next view tries again');
    const noStore = await addSeller('nostore', false);
    const noStoreOrder = await addBareOrder(noStore, 9005);
    const calls = fetched.length;
    res = await get(`/api/orders/${noStoreOrder}`, noStore);
    check(res.status === 200 && /Connect your store/.test(res.body.line_items_note) && res.body.shopify_admin_url === null, 'store not connected: a note, no link', res.body.line_items_note);
    check(fetched.length === calls, 'and no Shopify call');

    console.log('\n5. Not found');
    res = await get(`/api/orders/${orderId}`, noStore);
    check(res.status === 404, 'another seller\'s order is 404', String(res.status));
    res = await get('/api/orders/99999999', seller);
    check(res.status === 404 && res.body?.error === 'Order not found', 'an unknown id is 404');
    res = await get('/api/orders/abc', seller);
    check(res.status === 404, 'a non-numeric id is 404', String(res.status));
  } finally {
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]); // line items go with them
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
