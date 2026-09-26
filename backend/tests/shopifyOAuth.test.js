const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.SHOPIFY_API_KEY = 'test-client-id';
process.env.SHOPIFY_API_SECRET = 'hush';
process.env.APP_URL = 'https://ops.example.com/';
process.env.SHOPIFY_SCOPES = 'read_orders, read_products,read_inventory';
const oauth = require('../src/services/shopifyOAuth');
const { needsRefresh } = require('../src/models/sellerModel');

test("verifies Shopify's documented example callback", () => {
  // From shopify.dev (authorization code grant), client secret "hush".
  const query = {
    code: '0907a61c0c8d55e99db179b68161bc00',
    hmac: '700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf',
    shop: 'some-shop.myshopify.com',
    state: '0.6784241404160823',
    timestamp: '1337178173',
  };
  assert.equal(oauth.verifyQueryHmac(query), true);
  assert.equal(oauth.verifyQueryHmac({ ...query, shop: 'other-shop.myshopify.com' }), false);
  assert.equal(oauth.verifyQueryHmac({ ...query, hmac: query.hmac.toUpperCase() }), false);
  assert.equal(oauth.verifyQueryHmac({ ...query, hmac: undefined }), false);
  assert.equal(oauth.verifyQueryHmac(query, 'wrong-secret'), false);
});

test('accepts the URL-encoded signing form too (values with = or &)', () => {
  const query = { host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUveA==', shop: 'x.myshopify.com', timestamp: '1700000000' };
  const encoded = new URLSearchParams(Object.entries(query).sort()).toString();
  const hmac = crypto.createHmac('sha256', 'hush').update(encoded).digest('hex');
  assert.equal(oauth.verifyQueryHmac({ ...query, hmac }), true);
});

test('normalizes what a seller types into a shop domain, and nothing else', () => {
  assert.equal(oauth.normalizeShopDomain('my-store'), 'my-store.myshopify.com');
  assert.equal(oauth.normalizeShopDomain(' My-Store.myshopify.com '), 'my-store.myshopify.com');
  assert.equal(oauth.normalizeShopDomain('https://my-store.myshopify.com/admin/orders'), 'my-store.myshopify.com');
  for (const bad of ['', 'my-store.myshopify.com.attacker.example', 'evil.com', '-x.myshopify.com', 'a b', null, 42]) {
    assert.equal(oauth.normalizeShopDomain(bad), null, String(bad));
  }
});

test('timestamps older than an hour are refused', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  assert.equal(oauth.isFreshTimestamp(String(now / 1000 - 60), now), true);
  assert.equal(oauth.isFreshTimestamp(String(now / 1000 - 2 * 3600), now), false);
  assert.equal(oauth.isFreshTimestamp('nope', now), false);
});

test('authorize URL asks for an offline token with the configured scopes and callback', () => {
  const url = new URL(oauth.buildAuthorizeUrl('my-store.myshopify.com', 'abc123'));
  assert.equal(url.origin + url.pathname, 'https://my-store.myshopify.com/admin/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('scope'), 'read_orders,read_products,read_inventory');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://ops.example.com/api/shopify/callback');
  assert.equal(url.searchParams.get('state'), 'abc123');
  assert.equal(url.searchParams.has('grant_options[]'), false); // per-user would make it an online token
});

test('reports missing scopes; write_x covers read_x', () => {
  assert.deepEqual(oauth.missingScopes('read_orders,read_products,read_inventory'), []);
  assert.deepEqual(oauth.missingScopes('read_orders,write_products'), ['read_inventory']);
  assert.deepEqual(oauth.missingScopes(''), ['read_orders', 'read_products', 'read_inventory']);
});

test('by default the app asks to read orders, products and stock, and to hold and fulfill orders', () => {
  const configured = process.env.SHOPIFY_SCOPES;
  delete process.env.SHOPIFY_SCOPES;
  try {
    assert.equal(oauth.config().scopes, 'read_orders,read_products,read_inventory,write_merchant_managed_fulfillment_orders');
  } finally {
    process.env.SHOPIFY_SCOPES = configured;
  }
});

test('holding and fulfilling need write_merchant_managed_fulfillment_orders; unknown grants are left to Shopify', () => {
  assert.equal(oauth.actionsAllowed('read_orders,write_merchant_managed_fulfillment_orders'), true);
  assert.equal(oauth.actionsAllowed('read_orders,read_merchant_managed_fulfillment_orders'), false);
  assert.equal(oauth.actionsAllowed('read_orders,read_products,read_inventory'), false);
  assert.equal(oauth.actionsAllowed(null), null);
  assert.equal(oauth.actionsAllowed(''), null);
});

test('token responses become stored tokens with an absolute expiry', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const token = oauth.tokenFromResponse(
    { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'read_orders' },
    now
  );
  assert.deepEqual(token, { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(now + 3600 * 1000), scopes: 'read_orders' });
  assert.deepEqual(oauth.tokenFromResponse({ access_token: 'a' }, now), {
    accessToken: 'a',
    refreshToken: null,
    expiresAt: null,
    scopes: null,
  });
});

test('expiring tokens refresh a minute early; pasted tokens never do', () => {
  const now = Date.parse('2026-09-25T12:00:00Z');
  const row = (msFromNow, refresh = 'enc') => ({
    shopify_refresh_token: refresh,
    shopify_token_expires_at: new Date(now + msFromNow),
  });
  assert.equal(needsRefresh(row(10 * 60 * 1000), now), false);
  assert.equal(needsRefresh(row(30 * 1000), now), true);
  assert.equal(needsRefresh(row(-5000), now), true);
  assert.equal(needsRefresh({ shopify_refresh_token: null, shopify_token_expires_at: null }, now), false);
});

test('OAuth is only offered when the app is fully configured', () => {
  assert.equal(oauth.isConfigured(), true);
  const saved = process.env.APP_URL;
  process.env.APP_URL = 'http://localhost:3000';
  assert.equal(oauth.isConfigured(), false); // Shopify needs https
  process.env.APP_URL = saved;
});
