const pool = require('../config/db');

// Shared by the Shopify sync and the orders/create webhook, so an order looks
// the same in our table no matter which path brought it in.
async function upsertOrder(sellerId, order) {
  await pool.query(
    `INSERT INTO orders
       (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
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
}

module.exports = { upsertOrder };
