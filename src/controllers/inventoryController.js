const pool = require('../config/db');

// GET /api/inventory/low-stock
// This is the exact query the "check_low_stock" MCP tool will call in Phase 3.
async function getLowStock(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM inventory_items
       WHERE seller_id = ?
       AND stock_quantity <= low_stock_threshold
       ORDER BY stock_quantity ASC`,
      [req.sellerId]
    );
    res.json({ low_stock_items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch low stock items' });
  }
}

module.exports = { getLowStock };
