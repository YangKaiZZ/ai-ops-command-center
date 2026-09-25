const pool = require('../config/db');

const text = (value, max = 255) => (value == null || value === '' ? null : String(value).slice(0, max));

// Product details only; line item `properties` can hold personal text, so they aren't kept.
function lineItemRow(orderId, item) {
  return [
    orderId,
    String(item.id),
    text(item.variant_id, 100),
    text(item.title ?? item.name) ?? 'Item',
    text(item.variant_title),
    text(item.sku),
    Number(item.quantity) || 0,
    item.fulfillable_quantity == null ? null : Number(item.fulfillable_quantity),
    item.price ?? null,
  ];
}

// Shared by the Shopify sync, the order webhooks and the order detail view, so
// an order looks the same in our tables no matter which path brought it in.
// A payload with line_items replaces the order's stored ones. Returns our order id.
async function upsertOrder(sellerId, order) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO orders
         (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id),
         status = VALUES(status),
         financial_status = VALUES(financial_status),
         total_amount = VALUES(total_amount),
         synced_at = CURRENT_TIMESTAMP`,
      [
        sellerId,
        order.id,
        order.name, // e.g. "#1001"
        order.fulfillment_status || 'unfulfilled',
        order.financial_status,
        order.customer ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 'Guest',
        order.total_price,
        order.created_at,
      ]
    );
    const orderId = result.insertId;
    if (Array.isArray(order.line_items)) {
      await conn.query('DELETE FROM order_line_items WHERE order_id = ?', [orderId]);
      if (order.line_items.length) {
        await conn.query(
          `INSERT INTO order_line_items
             (order_id, shopify_line_item_id, shopify_variant_id, title, variant_title, sku, quantity, fulfillable_quantity, price)
           VALUES ?`,
          [order.line_items.map((item) => lineItemRow(orderId, item))]
        );
      }
      await conn.query('UPDATE orders SET line_items_synced_at = NOW() WHERE id = ?', [orderId]);
    }
    await conn.commit();
    return orderId;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Shopify ids of orders placed in the last `days` that were saved before line
// items were kept, oldest first.
async function ordersMissingLineItems(sellerId, days) {
  const [rows] = await pool.query(
    `SELECT shopify_order_id FROM orders
     WHERE seller_id = ? AND line_items_synced_at IS NULL AND order_placed_at >= NOW() - INTERVAL ? DAY
     ORDER BY order_placed_at, id`,
    [sellerId, days]
  );
  return rows.map((row) => row.shopify_order_id);
}

// --- Fraud risk (services/riskCheck.js) ---

const RISK_COLUMNS = 'risk_level, risk_recommendation, risk_reasons, billing_matches_shipping, risk_checked_at';

// Not yet (fully) shipped, and not refunded or voided: it may still go out.
const OPEN_WHERE = `status IN ('unfulfilled', 'partial') AND COALESCE(financial_status, '') NOT IN ('refunded', 'voided')`;

// Saves an order's fraud analysis (riskCheck.summarizeRisk()).
async function saveRisk(sellerId, shopifyOrderId, risk) {
  await pool.query(
    `UPDATE orders SET risk_level = ?, risk_recommendation = ?, risk_reasons = ?, billing_matches_shipping = ?, risk_checked_at = NOW()
     WHERE seller_id = ? AND shopify_order_id = ?`,
    [risk.level, risk.recommendation, JSON.stringify(risk.reasons), risk.billing_matches_shipping, sellerId, String(shopifyOrderId)]
  );
}

// Open orders placed in the last `days`, newest first, with their stored risk
// and the verdict of the agent's latest decision on each (null if none).
async function openOrdersForRiskCheck(sellerId, days, limit) {
  const [rows] = await pool.query(
    `SELECT o.id, o.shopify_order_id, o.order_number, ${RISK_COLUMNS}, o.risk_alerted_at,
       (SELECT d.action_taken FROM decisions d WHERE d.seller_id = o.seller_id AND d.order_id = o.id
        ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS latest_verdict
     FROM orders o
     WHERE o.seller_id = ? AND ${OPEN_WHERE} AND o.order_placed_at >= NOW() - INTERVAL ? DAY
     ORDER BY o.order_placed_at DESC, o.id DESC
     LIMIT ?`,
    [sellerId, days, limit]
  );
  return rows;
}

async function markRiskAlerted(orderId) {
  await pool.query('UPDATE orders SET risk_alerted_at = NOW() WHERE id = ?', [orderId]);
}

module.exports = {
  upsertOrder,
  lineItemRow,
  ordersMissingLineItems,
  saveRisk,
  openOrdersForRiskCheck,
  markRiskAlerted,
  RISK_COLUMNS,
  OPEN_WHERE,
};
