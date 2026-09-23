const pool = require('../config/db');

// POST /api/store/connect
// Body: { shop_domain, access_token }
// In production with a real Partner-distributed app this would be an OAuth
// redirect flow. For our own dev store, we just paste the token in directly —
// same end result (a token stored per-seller), simpler for now.
async function connectStore(req, res) {
  try {
    const { shop_domain, access_token } = req.body;
    if (!shop_domain || !access_token) {
      return res.status(400).json({ error: 'shop_domain and access_token are required' });
    }

    await pool.query(
      'UPDATE sellers SET shopify_shop_domain = ?, shopify_access_token = ? WHERE id = ?',
      [shop_domain, access_token, req.sellerId]
    );

    res.json({ message: 'Store connected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not connect store' });
  }
}

module.exports = { connectStore };
