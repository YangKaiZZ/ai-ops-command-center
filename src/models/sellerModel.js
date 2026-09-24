const pool = require('../config/db');
const { encryptSecret, decryptSecret } = require('../config/secrets');

// Shopify only issues *.myshopify.com domains. Checking this stops a seller
// from pointing the backend (and their token) at some other host.
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function isValidShopDomain(domain) {
  return typeof domain === 'string' && SHOP_DOMAIN_RE.test(domain);
}

// This seller's Shopify credentials (token decrypted), or null if no store is connected.
async function getStoreCredentials(sellerId) {
  const [rows] = await pool.query(
    'SELECT shopify_shop_domain, shopify_access_token FROM sellers WHERE id = ?',
    [sellerId]
  );
  const seller = rows[0];
  if (!seller || !seller.shopify_shop_domain || !seller.shopify_access_token) return null;
  return { shopDomain: seller.shopify_shop_domain, accessToken: decryptSecret(seller.shopify_access_token) };
}

async function setStoreConnection(sellerId, shopDomain, accessToken) {
  await pool.query('UPDATE sellers SET shopify_shop_domain = ?, shopify_access_token = ? WHERE id = ?', [
    shopDomain.toLowerCase(),
    encryptSecret(accessToken),
    sellerId,
  ]);
}

async function findSellerByShopDomain(shopDomain) {
  const [rows] = await pool.query('SELECT id FROM sellers WHERE shopify_shop_domain = ?', [shopDomain]);
  return rows[0] || null;
}

// Sellers with a store to sync (for the scheduled sync).
async function getConnectedSellerIds() {
  const [rows] = await pool.query(
    'SELECT id FROM sellers WHERE shopify_shop_domain IS NOT NULL AND shopify_access_token IS NOT NULL ORDER BY id'
  );
  return rows.map((row) => row.id);
}

// When orders were last synced, so the next sync only asks Shopify for what changed since.
async function getOrdersSyncedAt(sellerId) {
  const [rows] = await pool.query('SELECT orders_synced_at FROM sellers WHERE id = ?', [sellerId]);
  return rows[0]?.orders_synced_at || null;
}

async function setOrdersSyncedAt(sellerId, when) {
  await pool.query('UPDATE sellers SET orders_synced_at = ? WHERE id = ?', [when, sellerId]);
}

// What the settings page shows. Secrets stay out: only whether they're set.
async function getSettings(sellerId) {
  const [rows] = await pool.query(
    'SELECT business_name, email, shopify_shop_domain, slack_webhook_url IS NOT NULL AS slack_connected FROM sellers WHERE id = ?',
    [sellerId]
  );
  const seller = rows[0];
  if (!seller) return null;
  return {
    business_name: seller.business_name,
    email: seller.email,
    store: { connected: Boolean(seller.shopify_shop_domain), shop_domain: seller.shopify_shop_domain },
    slack: { connected: Boolean(seller.slack_connected) },
  };
}

// Each seller's own Slack incoming webhook (encrypted: anyone holding the URL can post to that channel).
async function getSlackWebhookUrl(sellerId) {
  const [rows] = await pool.query('SELECT slack_webhook_url FROM sellers WHERE id = ?', [sellerId]);
  return decryptSecret(rows[0]?.slack_webhook_url);
}

async function setSlackWebhookUrl(sellerId, url) {
  await pool.query('UPDATE sellers SET slack_webhook_url = ? WHERE id = ?', [encryptSecret(url), sellerId]);
}

module.exports = {
  isValidShopDomain,
  getStoreCredentials,
  setStoreConnection,
  findSellerByShopDomain,
  getConnectedSellerIds,
  getOrdersSyncedAt,
  setOrdersSyncedAt,
  getSettings,
  getSlackWebhookUrl,
  setSlackWebhookUrl,
};
