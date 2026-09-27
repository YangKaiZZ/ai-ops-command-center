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

// 'Guest' when the order has no customer; null when it has one but Shopify
// leaves the name out (an app without approval for protected customer data
// gets the customer with no first_name/last_name).
function buyerName(customer) {
  if (!customer) return 'Guest';
  return text(`${customer.first_name || ''} ${customer.last_name || ''}`.trim());
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
         buyer_name = IF(buyer_name IS NULL OR buyer_name = '', VALUES(buyer_name), buyer_name),
         synced_at = CURRENT_TIMESTAMP`,
      [
        sellerId,
        order.id,
        order.name, // e.g. "#1001"
        order.fulfillment_status || 'unfulfilled',
        order.financial_status,
        buyerName(order.customer),
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

// An order's stored risk and the verdict of the agent's latest decision on it
// (null if none), for the risk re-checks.
const RISK_CHECK_SELECT = `SELECT o.id, o.shopify_order_id, o.order_number, ${RISK_COLUMNS}, o.risk_alerted_at,
   (SELECT d.action_taken FROM decisions d WHERE d.seller_id = o.seller_id AND d.order_id = o.id
    ORDER BY d.created_at DESC, d.id DESC LIMIT 1) AS latest_verdict
 FROM orders o`;

// Open orders placed in the last `days`, newest first (RISK_CHECK_SELECT).
async function openOrdersForRiskCheck(sellerId, days, limit) {
  const [rows] = await pool.query(
    `${RISK_CHECK_SELECT}
     WHERE o.seller_id = ? AND ${OPEN_WHERE} AND o.order_placed_at >= NOW() - INTERVAL ? DAY
     ORDER BY o.order_placed_at DESC, o.id DESC
     LIMIT ?`,
    [sellerId, days, limit]
  );
  return rows;
}

// One order by its Shopify id, if we have it and it's still open (RISK_CHECK_SELECT).
async function openOrderForRiskCheck(sellerId, shopifyOrderId) {
  const [[row]] = await pool.query(`${RISK_CHECK_SELECT} WHERE o.seller_id = ? AND o.shopify_order_id = ? AND ${OPEN_WHERE}`, [
    sellerId,
    String(shopifyOrderId),
  ]);
  return row ?? null;
}

async function markRiskAlerted(orderId) {
  await pool.query('UPDATE orders SET risk_alerted_at = NOW() WHERE id = ?', [orderId]);
}

// The seller whose order a Telegram button names, if that chat is the one
// linked to their account; null otherwise.
async function orderSellerForTelegramChat(orderId, chatId) {
  const [[row]] = await pool.query(
    `SELECT o.seller_id FROM orders o JOIN sellers s ON s.id = o.seller_id
     WHERE o.id = ? AND s.telegram_chat_id = ?`,
    [orderId, String(chatId)]
  );
  return row?.seller_id ?? null;
}

module.exports = {
  upsertOrder,
  lineItemRow,
  ordersMissingLineItems,
  saveRisk,
  openOrdersForRiskCheck,
  openOrderForRiskCheck,
  markRiskAlerted,
  orderSellerForTelegramChat,
  RISK_COLUMNS,
  OPEN_WHERE,
};
