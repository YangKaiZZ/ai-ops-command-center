const pool = require('../config/db');
const { encryptSecret, decryptSecret } = require('../config/secrets');

// Shopify apps made for one store each (migration 011): custom distribution
// installs an app on a single store, so every real seller has their own.

// { clientId, clientSecret } for the store, or null when it uses the server's app.
async function findStoreApp(shopDomain) {
  const [rows] = await pool.query('SELECT client_id, client_secret FROM store_apps WHERE shop_domain = ?', [shopDomain]);
  if (!rows[0]) return null;
  return { clientId: rows[0].client_id, clientSecret: decryptSecret(rows[0].client_secret) };
}

// Adds the store's app, or replaces its credentials (say, after rotating the secret).
async function saveStoreApp(shopDomain, clientId, clientSecret) {
  await pool.query(
    `INSERT INTO store_apps (shop_domain, client_id, client_secret) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE client_id = VALUES(client_id), client_secret = VALUES(client_secret)`,
    [shopDomain, clientId, encryptSecret(clientSecret)]
  );
}

// True when there was one to remove.
async function removeStoreApp(shopDomain) {
  const [result] = await pool.query('DELETE FROM store_apps WHERE shop_domain = ?', [shopDomain]);
  return result.affectedRows > 0;
}

// Every store app, without secrets, with whether an account has connected that store.
async function listStoreApps() {
  const [rows] = await pool.query(
    `SELECT a.shop_domain, a.client_id, a.created_at, s.id AS seller_id, s.business_name,
            s.shopify_access_token IS NOT NULL AS connected
     FROM store_apps a LEFT JOIN sellers s ON s.shopify_shop_domain = a.shop_domain
     ORDER BY a.created_at`
  );
  return rows.map((r) => ({ ...r, connected: Boolean(r.connected) }));
}

module.exports = { findStoreApp, saveStoreApp, removeStoreApp, listStoreApps };
