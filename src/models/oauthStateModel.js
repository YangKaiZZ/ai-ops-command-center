const crypto = require('crypto');
const pool = require('../config/db');

// The `state` sent to Shopify's approval page and checked when Shopify
// redirects back. It ties the callback to the seller who started it and the
// shop they asked for, expires after 15 minutes, and works once.
const STATE_TTL_MINUTES = 15;

async function createOAuthState(sellerId, shop) {
  const state = crypto.randomBytes(24).toString('hex');
  await pool.query('DELETE FROM oauth_states WHERE expires_at < NOW()'); // housekeeping
  await pool.query(
    'INSERT INTO oauth_states (state, seller_id, shop, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL ? MINUTE)',
    [state, sellerId, shop, STATE_TTL_MINUTES]
  );
  return state;
}

// { sellerId, shop } if the state is valid, else null. Deleting it first
// means a replayed callback finds nothing.
async function consumeOAuthState(state) {
  if (typeof state !== 'string' || !state) return null;
  const [rows] = await pool.query('SELECT seller_id, shop, expires_at > NOW() AS live FROM oauth_states WHERE state = ?', [state]);
  const row = rows[0];
  if (!row) return null;
  const [result] = await pool.query('DELETE FROM oauth_states WHERE state = ?', [state]);
  if (result.affectedRows !== 1 || !row.live) return null;
  return { sellerId: row.seller_id, shop: row.shop };
}

module.exports = { createOAuthState, consumeOAuthState };
