const crypto = require('crypto');
const pool = require('../config/db');

// Long-lived keys for tools like the MCP server in Claude Desktop, which
// can't sign in and shouldn't break every 7 days when a session expires.
// Only a SHA-256 hash is stored; the key itself is shown once, at creation.
const KEY_PREFIX = 'aiops_';
const MAX_ACTIVE_KEYS = 20;

function isApiKey(token) {
  return typeof token === 'string' && token.startsWith(KEY_PREFIX);
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  return KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

async function createApiKey(sellerId, name) {
  const [[{ active }]] = await pool.query(
    'SELECT COUNT(*) AS active FROM api_keys WHERE seller_id = ? AND revoked_at IS NULL',
    [sellerId]
  );
  if (active >= MAX_ACTIVE_KEYS) return { error: `You can have up to ${MAX_ACTIVE_KEYS} active keys. Revoke one first.` };

  const key = generateApiKey();
  const prefix = key.slice(0, KEY_PREFIX.length + 6); // enough to tell keys apart in a list
  const [result] = await pool.query('INSERT INTO api_keys (seller_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)', [
    sellerId,
    name,
    prefix,
    hashApiKey(key),
  ]);
  const [[row]] = await pool.query(
    'SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys WHERE id = ?',
    [result.insertId]
  );
  return { key, apiKey: row };
}

async function listApiKeys(sellerId) {
  const [rows] = await pool.query(
    `SELECT id, name, key_prefix, created_at, last_used_at FROM api_keys
     WHERE seller_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC`,
    [sellerId]
  );
  return rows;
}

// True if a key was revoked; false if it doesn't exist, isn't this seller's, or was already revoked.
async function revokeApiKey(sellerId, id) {
  const [result] = await pool.query(
    'UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND seller_id = ? AND revoked_at IS NULL',
    [id, sellerId]
  );
  return result.affectedRows > 0;
}

// The seller a key belongs to, or null if it's unknown or revoked.
async function findSellerIdByApiKey(key) {
  const [rows] = await pool.query('SELECT id, seller_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [
    hashApiKey(key),
  ]);
  const row = rows[0];
  if (!row) return null;
  // "Last used" for the settings page; at most one write a minute per key.
  pool
    .query(
      'UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL 1 MINUTE)',
      [row.id]
    )
    .catch((err) => console.error(`[api key] could not update last_used_at: ${err.message}`));
  return row.seller_id;
}

module.exports = { isApiKey, hashApiKey, generateApiKey, createApiKey, listApiKeys, revokeApiKey, findSellerIdByApiKey };
