const pool = require('../config/db');

// Shopify's mandatory privacy (GDPR) webhooks. What we hold about a store's
// customers: the buyer's name and totals on synced orders, and whatever the
// agent wrote about those orders in its decisions.

// A log of every privacy request, with ids only (no personal data), so
// there's a record of what was asked and done.
async function recordPrivacyRequest(sellerId, topic, shopDomain, details) {
  await pool.query('INSERT INTO privacy_requests (seller_id, topic, shop_domain, details) VALUES (?, ?, ?, ?)', [
    sellerId,
    topic,
    shopDomain,
    JSON.stringify(details),
  ]);
}

// customers/data_request: what we hold for these orders, for the merchant
// to pass on. Computed when asked, so it's never a stale copy.
async function customerData(sellerId, shopifyOrderIds) {
  const ids = shopifyOrderIds.map(String);
  if (!ids.length) return { orders: [], decisions: [] };
  const [orders] = await pool.query(
    `SELECT id, shopify_order_id, order_number, buyer_name, total_amount, status, financial_status, order_placed_at
     FROM orders WHERE seller_id = ? AND shopify_order_id IN (?)`,
    [sellerId, ids]
  );
  const [decisions] = orders.length
    ? await pool.query(
        'SELECT order_number, action_taken, reasoning, created_at, feedback_note FROM decisions WHERE seller_id = ? AND order_id IN (?)',
        [sellerId, orders.map((o) => o.id)]
      )
    : [[]];
  return { orders: orders.map(({ id, ...o }) => o), decisions };
}

// customers/redact: removes the buyer's name from their orders and from any
// decision text (the agent's or the seller's note) that mentions it. Returns
// how many orders were redacted.
async function redactCustomer(sellerId, shopifyOrderIds) {
  const ids = shopifyOrderIds.map(String);
  if (!ids.length) return 0;
  const [orders] = await pool.query(
    'SELECT DISTINCT buyer_name FROM orders WHERE seller_id = ? AND shopify_order_id IN (?)',
    [sellerId, ids]
  );
  for (const { buyer_name: name } of orders) {
    if (!name || name === 'Guest' || name === 'Redacted' || name.length < 3) continue;
    await pool.query(
      "UPDATE decisions SET reasoning = REPLACE(reasoning, ?, '[redacted]'), feedback_note = REPLACE(feedback_note, ?, '[redacted]') WHERE seller_id = ?",
      [name, name, sellerId]
    );
  }
  const [result] = await pool.query(
    "UPDATE orders SET buyer_name = 'Redacted' WHERE seller_id = ? AND shopify_order_id IN (?)",
    [sellerId, ids]
  );
  return result.affectedRows;
}

// shop/redact (48 hours after the app is uninstalled): deletes everything we
// synced from the store and lets go of the shop. The seller's own login stays.
async function redactShop(sellerId) {
  const counts = {};
  for (const table of ['decisions', 'orders', 'inventory_items', 'customer_messages']) {
    const [result] = await pool.query(`DELETE FROM ${table} WHERE seller_id = ?`, [sellerId]);
    counts[table] = result.affectedRows;
  }
  await pool.query(
    `UPDATE sellers SET shopify_shop_domain = NULL, shopify_scopes = NULL, orders_synced_at = NULL
     WHERE id = ? AND shopify_access_token IS NULL`,
    [sellerId]
  );
  return counts;
}

// Data requests received for this seller, with what we currently hold for each.
async function listDataRequests(sellerId) {
  const [rows] = await pool.query(
    "SELECT id, details, received_at FROM privacy_requests WHERE seller_id = ? AND topic = 'customers/data_request' ORDER BY id DESC LIMIT 50",
    [sellerId]
  );
  const requests = [];
  for (const row of rows) {
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
    requests.push({ id: row.id, received_at: row.received_at, ...details, data: await customerData(sellerId, details.order_ids || []) });
  }
  return requests;
}

module.exports = { recordPrivacyRequest, customerData, redactCustomer, redactShop, listDataRequests };
