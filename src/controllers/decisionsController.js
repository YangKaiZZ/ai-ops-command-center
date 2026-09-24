const pool = require('../config/db');

// GET /api/decisions?limit=50
// The agent's recent decisions for this seller, newest first — the dashboard feed.
async function getDecisions(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const [rows] = await pool.query(
      `SELECT id, order_id, order_number, action_taken, reasoning, created_at
       FROM decisions
       WHERE seller_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [req.sellerId, limit]
    );
    res.json({ decisions: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch decisions' });
  }
}

module.exports = { getDecisions };
