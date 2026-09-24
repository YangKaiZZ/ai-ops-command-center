const pool = require('../config/db');
const { encryptSecret, decryptSecret } = require('../config/secrets');
const oauth = require('../services/shopifyOAuth');
const { withLock } = require('../utils/lock');

// Refresh an expiring token this long before it runs out, so a request never
// goes out with a token that lapses mid-flight.
const REFRESH_MARGIN_MS = 60 * 1000;

async function loadStoreRow(sellerId) {
  const [rows] = await pool.query(
    `SELECT shopify_shop_domain, shopify_access_token, shopify_refresh_token, shopify_token_expires_at
     FROM sellers WHERE id = ?`,
    [sellerId]
  );
  const row = rows[0];
  return row && row.shopify_shop_domain && row.shopify_access_token ? row : null;
}

function needsRefresh(row, nowMs = Date.now()) {
  return Boolean(
    row.shopify_refresh_token &&
      row.shopify_token_expires_at &&
      new Date(row.shopify_token_expires_at).getTime() - REFRESH_MARGIN_MS <= nowMs
  );
}

// This seller's Shopify credentials (token decrypted), or null if no store is
// connected. Tokens from "Connect with Shopify" expire hourly and are
// refreshed here, one refresh at a time per seller: each refresh invalidates
// the previous refresh token, so two racing refreshes would lock the store out.
async function getStoreCredentials(sellerId) {
  const row = await loadStoreRow(sellerId);
  if (!row) return null;
  if (!needsRefresh(row)) return { shopDomain: row.shopify_shop_domain, accessToken: decryptSecret(row.shopify_access_token) };

  return withLock(`shopify-token:${sellerId}`, async () => {
    const current = await loadStoreRow(sellerId); // may have been refreshed while we waited
    if (!current) return null;
    const shopDomain = current.shopify_shop_domain;
    if (!needsRefresh(current)) return { shopDomain, accessToken: decryptSecret(current.shopify_access_token) };

    try {
      const token = await oauth.refreshAccessToken(shopDomain, decryptSecret(current.shopify_refresh_token));
      await saveTokens(sellerId, token);
      return { shopDomain, accessToken: token.accessToken };
    } catch (err) {
      const status = err.response?.status;
      if (status === 400 || status === 401) {
        // The refresh token expired or was revoked: only reconnecting fixes it.
        await clearShopifyToken(sellerId);
        console.warn(`[shopify] seller ${sellerId}: token refresh rejected (HTTP ${status}); store needs reconnecting`);
        return null;
      }
      throw err;
    }
  });
}

// Stores a new connection. token: { accessToken, refreshToken, expiresAt, scopes }.
// A pasted custom-app token has no refresh token or expiry.
async function saveShopifyConnection(sellerId, shopDomain, token) {
  await pool.query(
    `UPDATE sellers SET shopify_shop_domain = ?, shopify_access_token = ?, shopify_refresh_token = ?,
       shopify_token_expires_at = ?, shopify_scopes = ?
     WHERE id = ?`,
    [
      shopDomain.toLowerCase(),
      encryptSecret(token.accessToken),
      encryptSecret(token.refreshToken),
      token.expiresAt || null,
      token.scopes || null,
      sellerId,
    ]
  );
}

async function saveTokens(sellerId, token) {
  await pool.query(
    `UPDATE sellers SET shopify_access_token = ?, shopify_refresh_token = ?, shopify_token_expires_at = ?,
       shopify_scopes = COALESCE(?, shopify_scopes)
     WHERE id = ?`,
    [encryptSecret(token.accessToken), encryptSecret(token.refreshToken), token.expiresAt || null, token.scopes || null, sellerId]
  );
}

// Disconnected (uninstalled, revoked, or disconnected by the seller). The
// shop domain stays so later webhooks for that shop (e.g. shop/redact) still
// find this seller.
async function clearShopifyToken(sellerId) {
  await pool.query(
    `UPDATE sellers SET shopify_access_token = NULL, shopify_refresh_token = NULL, shopify_token_expires_at = NULL
     WHERE id = ?`,
    [sellerId]
  );
}

// { id, connected } for the seller holding this shop domain, or null.
async function findSellerByShopDomain(shopDomain) {
  const [rows] = await pool.query(
    'SELECT id, shopify_access_token IS NOT NULL AS connected FROM sellers WHERE shopify_shop_domain = ?',
    [String(shopDomain || '').toLowerCase()]
  );
  const row = rows[0];
  return row ? { id: row.id, connected: Boolean(row.connected) } : null;
}

// A store can belong to one account at a time. When a new account connects a
// store that an old account had disconnected, the old account lets go of it.
async function releaseShopDomain(shopDomain, keepSellerId) {
  await pool.query(
    'UPDATE sellers SET shopify_shop_domain = NULL WHERE shopify_shop_domain = ? AND id <> ? AND shopify_access_token IS NULL',
    [shopDomain.toLowerCase(), keepSellerId]
  );
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
    `SELECT business_name, email, shopify_shop_domain, shopify_scopes, default_low_stock_threshold,
       shopify_access_token IS NOT NULL AS store_connected, slack_webhook_url IS NOT NULL AS slack_connected
     FROM sellers WHERE id = ?`,
    [sellerId]
  );
  const seller = rows[0];
  if (!seller) return null;
  const connected = Boolean(seller.store_connected);
  return {
    business_name: seller.business_name,
    email: seller.email,
    store: {
      connected,
      shop_domain: connected ? seller.shopify_shop_domain : null,
      missing_scopes: connected && seller.shopify_scopes ? oauth.missingScopes(seller.shopify_scopes) : [],
    },
    shopify: { oauth_available: oauth.isConfigured() },
    inventory: { default_low_stock_threshold: seller.default_low_stock_threshold },
    slack: { connected: Boolean(seller.slack_connected) },
  };
}

// The low-stock threshold new items start with.
async function getDefaultThreshold(sellerId) {
  const [rows] = await pool.query('SELECT default_low_stock_threshold FROM sellers WHERE id = ?', [sellerId]);
  return rows[0]?.default_low_stock_threshold ?? 5;
}

async function setDefaultThreshold(sellerId, threshold) {
  await pool.query('UPDATE sellers SET default_low_stock_threshold = ? WHERE id = ?', [threshold, sellerId]);
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
  needsRefresh,
  getStoreCredentials,
  saveShopifyConnection,
  clearShopifyToken,
  findSellerByShopDomain,
  releaseShopDomain,
  getConnectedSellerIds,
  getOrdersSyncedAt,
  setOrdersSyncedAt,
  getSettings,
  getDefaultThreshold,
  setDefaultThreshold,
  getSlackWebhookUrl,
  setSlackWebhookUrl,
};
