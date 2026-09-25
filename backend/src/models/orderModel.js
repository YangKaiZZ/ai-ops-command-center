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

module.exports = { upsertOrder, lineItemRow, ordersMissingLineItems };
