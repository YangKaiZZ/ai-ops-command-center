const pool = require('../config/db');

// Shopify's mandatory privacy (GDPR) webhooks. What we hold about a store's
// customers: the buyer's name, totals and Shopify's fraud check on synced
// orders, and whatever the agent wrote about those orders in its decisions.

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
  if (!ids.length) return { orders: [], decisions: [], shopify_actions: [] };
  const [orders] = await pool.query(
    `SELECT id, shopify_order_id, order_number, buyer_name, total_amount, status, financial_status, order_placed_at,
       risk_level, risk_recommendation, risk_reasons, billing_matches_shipping
     FROM orders WHERE seller_id = ? AND shopify_order_id IN (?)`,
    [sellerId, ids]
  );
  if (!orders.length) return { orders: [], decisions: [], shopify_actions: [] };
  const orderIds = orders.map((o) => o.id);
  const [decisions] = await pool.query(
    'SELECT order_number, action_taken, reasoning, created_at, feedback_note FROM decisions WHERE seller_id = ? AND order_id IN (?)',
    [sellerId, orderIds]
  );
  // Holds and fulfillments done from here: a hold's note, a tracking number.
  const [actions] = await pool.query(
    `SELECT o.order_number, a.action, a.reason, a.note, a.created_at FROM order_actions a JOIN orders o ON o.id = a.order_id
     WHERE a.seller_id = ? AND a.order_id IN (?) AND a.ok`,
    [sellerId, orderIds]
  );
  return { orders: orders.map(({ id, ...o }) => o), decisions, shopify_actions: actions };
}

// customers/redact: removes the buyer's name from their orders and from any
// text that mentions it (the agent's decisions, the seller's notes, hold
// notes), and the fraud check's reasons (they can describe the buyer, e.g.
// where they ordered from). Returns how many orders were redacted.
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
    await pool.query("UPDATE order_actions SET note = REPLACE(note, ?, '[redacted]') WHERE seller_id = ?", [name, sellerId]);
  }
  const [result] = await pool.query(
    "UPDATE orders SET buyer_name = 'Redacted', risk_reasons = NULL WHERE seller_id = ? AND shopify_order_id IN (?)",
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
