const pool = require('../config/db');

// GET /api/orders
// Returns this seller's orders only — scoped by req.sellerId from the auth middleware.
async function getOrders(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM orders WHERE seller_id = ? ORDER BY order_placed_at DESC',
      [req.sellerId]
    );
    res.json({ orders: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch orders' });
  }
}

// GET /api/orders/pending
// Orders that need action: not yet (fully) shipped, or not yet paid.
// Refunded/voided orders are dead, so they're skipped. Oldest first = most urgent.
// This is the exact query the "get_pending_orders" MCP tool will call in Phase 3.
async function getPendingOrders(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM orders
       WHERE seller_id = ?
       AND (status IN ('unfulfilled', 'partial')
            OR financial_status IN ('pending', 'authorized', 'partially_paid'))
       AND COALESCE(financial_status, '') NOT IN ('refunded', 'voided')
       ORDER BY order_placed_at ASC`,
      [req.sellerId]
    );
    res.json({ pending_orders: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch pending orders' });
  }
}

module.exports = { getOrders, getPendingOrders };
