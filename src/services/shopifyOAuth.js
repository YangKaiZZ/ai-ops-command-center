const crypto = require('crypto');
const axios = require('axios');

// Shopify's OAuth (authorization code grant) for "Connect with Shopify".
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant

const DEFAULT_SCOPES = 'read_orders,read_products,read_inventory';
const MAX_REQUEST_AGE_S = 60 * 60; // install/callback links older than this are refused

function config() {
  return {
    apiKey: process.env.SHOPIFY_API_KEY || '',
    // The client secret signs OAuth redirects and webhooks alike.
    apiSecret: process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET || '',
    scopes: (process.env.SHOPIFY_SCOPES || DEFAULT_SCOPES).replace(/\s+/g, ''),
    appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
    dashboardUrl: (process.env.DASHBOARD_URL || 'http://localhost:3005').replace(/\/+$/, ''),
  };
}

// OAuth needs the app's client ID + secret and a public https URL Shopify can redirect to.
function isConfigured() {
  const { apiKey, apiSecret, appUrl } = config();
  return Boolean(apiKey && apiSecret && appUrl.startsWith('https://'));
}

// Accepts what a seller might type ("my-store", "my-store.myshopify.com",
// "https://my-store.myshopify.com/admin") and returns "my-store.myshopify.com",
// or null. The anchored pattern is Shopify's: without the $, a host like
// my-store.myshopify.com.attacker.example would pass.
function normalizeShopDomain(input) {
  if (typeof input !== 'string') return null;
  let shop = input.trim().toLowerCase();
  shop = shop.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (shop && !shop.includes('.')) shop = `${shop}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

// Shopify signs install and callback redirects: hmac = HMAC-SHA256 (hex) of
// the other query params, sorted by key and joined as key=value&key=value.
// Implementations differ on whether values are URL-encoded in that string,
// so both forms are accepted; each still needs the client secret to forge.
function verifyQueryHmac(query, secret = config().apiSecret) {
  if (!secret || typeof query?.hmac !== 'string') return false;
  const entries = Object.entries(query)
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : String(value)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const raw = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const encoded = new URLSearchParams(entries).toString();
  const received = Buffer.from(query.hmac, 'utf8');
  return [raw, encoded].some((message) => {
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(message).digest('hex'), 'utf8');
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  });
}

function isFreshTimestamp(timestamp, nowMs = Date.now()) {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && Math.abs(nowMs / 1000 - seconds) <= MAX_REQUEST_AGE_S;
}

function callbackUrl() {
  return `${config().appUrl}/api/shopify/callback`;
}

// Where the seller approves the app. No grant_options[] = an offline token
// (belongs to the store, not a staff member), which background syncs need.
function buildAuthorizeUrl(shop, state) {
  const { apiKey, scopes } = config();
  const params = new URLSearchParams({ client_id: apiKey, scope: scopes, redirect_uri: callbackUrl(), state });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}

// Turns Shopify's token response into what we store.
function tokenFromResponse(data, nowMs = Date.now()) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_in ? new Date(nowMs + Number(data.expires_in) * 1000) : null,
    scopes: data.scope || null,
  };
}

// Swaps the one-time code from the callback for an access token. Asks for an
// expiring offline token (1 hour, with a refresh token): Shopify requires
// those for new public apps.
async function exchangeCode(shop, code) {
  const { apiKey, apiSecret } = config();
  const { data } = await axios.post(
    `https://${shop}/admin/oauth/access_token`,
    { client_id: apiKey, client_secret: apiSecret, code, expiring: '1' },
    { timeout: 20000 }
  );
  return tokenFromResponse(data);
}

// Every refresh returns a new access token AND a new refresh token, and the
// old refresh token stops working, so callers must save the result.
async function refreshAccessToken(shop, refreshToken) {
  const { apiKey, apiSecret } = config();
  const { data } = await axios.post(
    `https://${shop}/admin/oauth/access_token`,
    { client_id: apiKey, client_secret: apiSecret, grant_type: 'refresh_token', refresh_token: refreshToken },
    { timeout: 20000 }
  );
  return tokenFromResponse(data);
}

// The scopes a token actually has (works for pasted custom-app tokens too).
async function fetchGrantedScopes(shop, accessToken) {
  const { data } = await axios.get(`https://${shop}/admin/oauth/access_scopes.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
    timeout: 20000,
  });
  return data.access_scopes.map((s) => s.handle).join(',');
}

// Required scopes the grant is missing. A write_x scope includes read_x.
function missingScopes(granted, required = config().scopes) {
  const have = new Set(String(granted || '').split(',').map((s) => s.trim()).filter(Boolean));
  return required
    .split(',')
    .filter(Boolean)
    .filter((scope) => !have.has(scope) && !(scope.startsWith('read_') && have.has(`write_${scope.slice(5)}`)));
}

// Uninstalls the app from the store (Shopify then sends app/uninstalled).
async function revokeAccess(shop, accessToken) {
  await axios.delete(`https://${shop}/admin/api_permissions/current.json`, {
    headers: { 'X-Shopify-Access-Token': accessToken },
    timeout: 20000,
  });
}

module.exports = {
  config,
  isConfigured,
  normalizeShopDomain,
  verifyQueryHmac,
  isFreshTimestamp,
  buildAuthorizeUrl,
  tokenFromResponse,
  exchangeCode,
  refreshAccessToken,
  fetchGrantedScopes,
  missingScopes,
  revokeAccess,
};
