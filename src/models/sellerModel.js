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

module.exports = { isValidShopDomain, getStoreCredentials, setStoreConnection, findSellerByShopDomain };
