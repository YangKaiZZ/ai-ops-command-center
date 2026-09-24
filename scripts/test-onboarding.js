// End-to-end check of store onboarding, run in-process against a fake Shopify
// (nothing leaves this machine; the real database is used with throwaway sellers):
//   1. Connect with Shopify: approval URL, callback checks (signature, state,
//      replay), token + scopes saved encrypted, webhooks + first sync started
//   2. One account per store
//   3. Token refresh: one refresh for parallel callers; a rejected refresh disconnects
//   4. Pasted custom-app token: validated against Shopify first
//   5. app/uninstalled webhook disconnects but keeps the shop for later webhooks
//   6. Shopify-side install link: new shop -> sign-up, known shop -> approval
//   7. Disconnect button, and switching stores clears the old store's data
//   8. Privacy (GDPR) webhooks
//   9. Low-stock thresholds: seller default for new items, per-item overrides
//
// Usage:  npm run test:onboarding
const path = require('path');
process.chdir(path.join(__dirname, '..'));
// Test app credentials, set before anything loads .env (dotenv never overrides them).
Object.assign(process.env, {
  SHOPIFY_API_KEY: 'onboarding-test-client',
  SHOPIFY_API_SECRET: 'onboarding-test-secret',
  APP_URL: 'https://ops.example.test',
  DASHBOARD_URL: 'http://dashboard.example.test',
  SHOPIFY_SCOPES: 'read_orders,read_products,read_inventory',
});

const crypto = require('crypto');
const app = require('../src/app');
const pool = require('../src/config/db');
const oauth = require('../src/services/shopifyOAuth');
const webhookSetup = require('../src/services/webhookSetup');
const syncService = require('../src/services/syncService');
const sellers = require('../src/models/sellerModel');
const { createApiKey } = require('../src/models/apiKeyModel');

const SECRET = process.env.SHOPIFY_API_SECRET;
const RUN = crypto.randomBytes(3).toString('hex');
const SHOP = `onboard-${RUN}.myshopify.com`;
const SHOP_2 = `onboard-${RUN}-b.myshopify.com`;
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- fake Shopify: record calls, return canned answers ---
const calls = [];
let nextToken = null;
let scopesFor = () => 'read_orders,read_products,read_inventory';
let refreshBehaviour = null;
oauth.exchangeCode = async (shop, code) => {
  calls.push(['exchangeCode', shop, code]);
  return nextToken;
};
oauth.fetchGrantedScopes = async (shop, token) => {
  calls.push(['fetchGrantedScopes', shop]);
  return scopesFor(shop, token);
};
oauth.revokeAccess = async (shop) => calls.push(['revokeAccess', shop]);
oauth.refreshAccessToken = async (shop, refreshToken) => {
  calls.push(['refreshAccessToken', shop, refreshToken]);
  return refreshBehaviour(refreshToken);
};
webhookSetup.registerWebhooks = async (creds, baseUrl) => {
  calls.push(['registerWebhooks', creds.shopDomain, baseUrl]);
  return { existing: [], results: Object.keys(webhookSetup.WEBHOOK_TOPICS).map((topic) => ({ topic, action: 'registered' })) };
};
syncService.syncOrders = async (id) => (calls.push(['syncOrders', id]), { message: 'fake orders sync' });
syncService.syncInventory = async (id) => (calls.push(['syncInventory', id]), { message: 'fake inventory sync' });
const called = (name) => calls.filter((c) => c[0] === name);

// --- HTTP helpers against the in-process app ---
let base;
async function http(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method,
    redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, location: res.headers.get('location'), json, text };
}

// Query string signed the way Shopify signs redirects.
function signedQuery(params) {
  const message = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hmac = crypto.createHmac('sha256', SECRET).update(message).digest('hex');
  return new URLSearchParams({ ...params, hmac }).toString();
}
const now = () => String(Math.floor(Date.now() / 1000));

async function register(label) {
  const r = await http('POST', '/api/auth/register', {
    body: { business_name: `Onboarding ${label}`, email: `onboarding-${RUN}-${label}@example.test`, password: 'test-password-1' },
  });
  return { id: r.json.sellerId, token: r.json.token };
}

async function connectViaShopify(seller, shop) {
  const start = await http('POST', '/api/shopify/connect', { token: seller.token, body: { shop } });
  const authorize = start.json?.authorize_url && new URL(start.json.authorize_url);
  const state = authorize?.searchParams.get('state');
  // Shopify sends back its own domain for the store, whatever the seller typed.
  const cb =
    state &&
    (await http('GET', `/api/shopify/callback?${signedQuery({ code: `code-${state.slice(0, 6)}`, shop: authorize.host, state, timestamp: now() })}`));
  return { start, state, cb };
}

async function row(sellerId) {
  const [[r]] = await pool.query(
    `SELECT shopify_shop_domain, shopify_access_token, shopify_refresh_token, shopify_token_expires_at, shopify_scopes
     FROM sellers WHERE id = ?`,
    [sellerId]
  );
  return r;
}

async function signedWebhook(topic, route, payload, shop) {
  const raw = JSON.stringify(payload);
  return http('POST', `/api/webhooks/${route}`, {
    body: raw,
    headers: {
      'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', SECRET).update(raw).digest('base64'),
      'X-Shopify-Shop-Domain': shop,
      'X-Shopify-Topic': topic,
      'X-Shopify-Webhook-Id': crypto.randomUUID(),
    },
  });
}

async function main() {
  const a = await register('a');
  const b = await register('b');
  const created = [a.id, b.id];
  try {
    console.log(`Sellers #${a.id} (A) and #${b.id} (B), shop ${SHOP}`);

    console.log('\n1. Connect with Shopify');
    nextToken = { accessToken: 'shpat_first', refreshToken: 'refresh-1', expiresAt: new Date(Date.now() + 3600e3), scopes: 'read_orders,read_products' };
    const { start, state, cb } = await connectViaShopify(a, `https://${SHOP.toUpperCase()}/admin`);
    const authorize = new URL(start.json.authorize_url);
    check(start.status === 200 && authorize.host === SHOP, 'approval URL for the normalized shop', authorize.host);
    check(authorize.searchParams.get('redirect_uri') === 'https://ops.example.test/api/shopify/callback', 'redirect_uri is APP_URL/api/shopify/callback');
    check(cb.status === 302 && cb.location === 'http://dashboard.example.test/settings?shopify=connected', 'callback lands on Settings, connected', cb.location);
    check(called('exchangeCode').length === 1 && called('exchangeCode')[0][1] === SHOP, 'code exchanged with Shopify');

    const saved = await row(a.id);
    check(saved.shopify_shop_domain === SHOP && saved.shopify_access_token.startsWith('enc:v1:') && saved.shopify_refresh_token.startsWith('enc:v1:'), 'token + refresh token stored encrypted');
    check(saved.shopify_token_expires_at != null && saved.shopify_scopes === 'read_orders,read_products', 'expiry and granted scopes stored');
    check(called('registerWebhooks').some((c) => c[1] === SHOP && c[2] === 'https://ops.example.test'), 'webhooks registered at APP_URL');
    await new Promise((r) => setTimeout(r, 50));
    check(called('syncOrders').length === 1 && called('syncInventory').length === 1, 'first sync started');

    const replay = await http('GET', `/api/shopify/callback?${signedQuery({ code: 'code-again', shop: SHOP, state, timestamp: now() })}`);
    check(/shopify=error/.test(replay.location) && /already used/.test(decodeURIComponent(replay.location)), 'replayed callback refused', decodeURIComponent(replay.location.split('message=')[1]));
    const forged = await http('GET', `/api/shopify/callback?code=x&shop=${SHOP}&state=${state}&timestamp=${now()}&hmac=${'0'.repeat(64)}`);
    check(/couldn't be verified/.test(decodeURIComponent(forged.location)), 'callback with a bad signature refused');
    const stale = await http('GET', `/api/shopify/callback?${signedQuery({ code: 'x', shop: SHOP, state: 'y', timestamp: String(Number(now()) - 7200) })}`);
    check(/expired/.test(decodeURIComponent(stale.location)), 'stale callback refused');

    const settings = await http('GET', '/api/settings', { token: a.token });
    check(
      settings.json.store.connected && settings.json.store.shop_domain === SHOP && settings.json.store.missing_scopes.join() === 'read_inventory',
      'settings: connected, missing read_inventory flagged',
      JSON.stringify(settings.json.store)
    );
    check(settings.json.shopify.oauth_available === true, 'settings: Connect with Shopify available');

    const { key } = await createApiKey(a.id, 'onboarding test');
    const withKey = await http('POST', '/api/shopify/connect', { token: key, body: { shop: SHOP } });
    check(withKey.status === 403, 'an API key cannot start a store connection', `HTTP ${withKey.status}`);
    const badShop = await http('POST', '/api/shopify/connect', { token: a.token, body: { shop: 'shop.myshopify.com.evil.example' } });
    check(badShop.status === 400, 'look-alike shop domain rejected', `HTTP ${badShop.status}`);

    console.log('\n2. One account per store');
    const taken = await http('POST', '/api/shopify/connect', { token: b.token, body: { shop: SHOP } });
    check(taken.status === 409, 'B cannot connect A\'s store', taken.json?.error);
    const takenManual = await http('POST', '/api/store/connect', { token: b.token, body: { shop_domain: SHOP, access_token: 'shpat_x' } });
    check(takenManual.status === 409, 'not with a pasted token either', `HTTP ${takenManual.status}`);

    console.log('\n3. Token refresh');
    await pool.query('UPDATE sellers SET shopify_token_expires_at = NOW() + INTERVAL 10 SECOND WHERE id = ?', [a.id]);
    let n = 1;
    refreshBehaviour = async (refreshToken) => {
      await new Promise((r) => setTimeout(r, 30));
      n++;
      return { accessToken: `shpat_refreshed_${n}`, refreshToken: `refresh-${n}`, expiresAt: new Date(Date.now() + 3600e3), scopes: null };
    };
    const parallel = await Promise.all([1, 2, 3].map(() => sellers.getStoreCredentials(a.id)));
    check(called('refreshAccessToken').length === 1, 'three callers at once -> one refresh', `${called('refreshAccessToken').length} refresh call(s)`);
    check(parallel.every((c) => c.accessToken === 'shpat_refreshed_2'), 'all get the new token');
    check(called('refreshAccessToken')[0][2] === 'refresh-1', 'refresh used the stored (decrypted) refresh token');
    const afterRefresh = await row(a.id);
    check(afterRefresh.shopify_scopes === 'read_orders,read_products' && new Date(afterRefresh.shopify_token_expires_at) > new Date(Date.now() + 3000e3), 'rotated token saved, scopes kept');
    const fresh = await sellers.getStoreCredentials(a.id);
    check(called('refreshAccessToken').length === 1 && fresh.accessToken === 'shpat_refreshed_2', 'a fresh token is not refreshed again');

    await pool.query('UPDATE sellers SET shopify_token_expires_at = NOW() - INTERVAL 1 SECOND WHERE id = ?', [a.id]);
    refreshBehaviour = async () => {
      throw Object.assign(new Error('invalid_grant'), { response: { status: 400 } });
    };
    const rejected = await sellers.getStoreCredentials(a.id);
    const afterReject = await row(a.id);
    check(rejected === null && afterReject.shopify_access_token === null && afterReject.shopify_shop_domain === SHOP, 'rejected refresh -> disconnected, shop kept');

    console.log('\n4. Pasted custom-app token');
    scopesFor = () => {
      throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    };
    const badToken = await http('POST', '/api/store/connect', { token: a.token, body: { shop_domain: SHOP, access_token: 'shpat_wrong' } });
    check(badToken.status === 400 && /didn't accept/.test(badToken.json.error), 'token Shopify rejects is not saved', badToken.json.error);
    scopesFor = () => 'read_orders,read_products,read_inventory';
    const manual = await http('POST', '/api/store/connect', { token: a.token, body: { shop_domain: SHOP, access_token: ' shpat_pasted ' } });
    check(manual.status === 200 && manual.json.missing_scopes.length === 0 && manual.json.webhooks.ok, 'valid token connects, webhooks set up', JSON.stringify(manual.json));
    const creds = await sellers.getStoreCredentials(a.id);
    const manualRow = await row(a.id);
    check(creds.accessToken === 'shpat_pasted' && manualRow.shopify_refresh_token === null && manualRow.shopify_token_expires_at === null, 'pasted token stored, never refreshed');

    console.log('\n5. app/uninstalled webhook');
    const uninstalled = await signedWebhook('app/uninstalled', 'app-uninstalled', { domain: SHOP }, SHOP);
    const afterUninstall = await row(a.id);
    check(uninstalled.status === 200 && afterUninstall.shopify_access_token === null && afterUninstall.shopify_shop_domain === SHOP, 'uninstall disconnects, shop kept for later webhooks');
    const settingsAfter = await http('GET', '/api/settings', { token: a.token });
    check(settingsAfter.json.store.connected === false && settingsAfter.json.store.shop_domain === null, 'settings: not connected');
    const forgedUninstall = await http('POST', '/api/webhooks/app-uninstalled', { body: '{}', headers: { 'X-Shopify-Hmac-Sha256': 'bad', 'X-Shopify-Shop-Domain': SHOP } });
    check(forgedUninstall.status === 401, 'unsigned uninstall webhook rejected', `HTTP ${forgedUninstall.status}`);

    nextToken = { accessToken: 'shpat_b', refreshToken: 'refresh-b', expiresAt: new Date(Date.now() + 3600e3), scopes: 'read_orders,read_products,read_inventory' };
    const bTakes = await connectViaShopify(b, SHOP);
    const [aNow, bNow] = [await row(a.id), await row(b.id)];
    check(bTakes.cb.location?.endsWith('shopify=connected') && bNow.shopify_shop_domain === SHOP && aNow.shopify_shop_domain === null, 'after uninstall, another account can connect the store (old one lets go)');

    console.log('\n6. Install link from Shopify');
    const fresh1 = await http('GET', `/api/shopify/install?${signedQuery({ shop: SHOP_2, timestamp: now() })}`);
    check(fresh1.status === 302 && fresh1.location === `http://dashboard.example.test/signup?shop=${SHOP_2}`, 'new shop -> sign-up page with the shop', fresh1.location);
    const known = await http('GET', `/api/shopify/install?${signedQuery({ shop: SHOP, timestamp: now() })}`);
    const knownUrl = known.location && new URL(known.location);
    check(known.status === 302 && knownUrl.host === SHOP && knownUrl.pathname === '/admin/oauth/authorize', 'known shop -> straight to approval');
    const [[st]] = await pool.query('SELECT seller_id FROM oauth_states WHERE state = ?', [knownUrl.searchParams.get('state')]);
    check(st?.seller_id === b.id, 'approval is tied to the account holding the shop');
    const forgedInstall = await http('GET', `/api/shopify/install?shop=${SHOP}&timestamp=${now()}&hmac=${'0'.repeat(64)}`);
    check(forgedInstall.status === 400, 'unsigned install link refused', `HTTP ${forgedInstall.status}`);

    console.log('\n7. Disconnect, and switching stores');
    const disconnect = await http('DELETE', '/api/store', { token: b.token });
    check(disconnect.status === 200 && called('revokeAccess').some((c) => c[1] === SHOP) && (await row(b.id)).shopify_access_token === null, 'disconnect uninstalls on Shopify and forgets the token');

    await pool.query(
      "INSERT INTO orders (seller_id, shopify_order_id, order_number, status) VALUES (?, 'old-1', '#OLD', 'unfulfilled')",
      [b.id]
    );
    await pool.query(
      "INSERT INTO inventory_items (seller_id, shopify_product_id, shopify_variant_id, item_name, stock_quantity) VALUES (?, 'p', 'old-v', 'Old item', 3)",
      [b.id]
    );
    nextToken = { accessToken: 'shpat_c', refreshToken: 'refresh-c', expiresAt: new Date(Date.now() + 3600e3), scopes: 'read_orders,read_products,read_inventory' };
    const sameShop = await connectViaShopify(b, SHOP);
    const [[{ keptOrders }]] = await pool.query('SELECT COUNT(*) AS keptOrders FROM orders WHERE seller_id = ?', [b.id]);
    check(sameShop.cb.location?.endsWith('shopify=connected') && keptOrders === 1, 'reconnecting the same store keeps its data');
    const switched = await connectViaShopify(b, SHOP_2);
    const [[{ orders }]] = await pool.query('SELECT COUNT(*) AS orders FROM orders WHERE seller_id = ?', [b.id]);
    const [[{ items }]] = await pool.query('SELECT COUNT(*) AS items FROM inventory_items WHERE seller_id = ?', [b.id]);
    check(switched.cb.location?.endsWith('shopify=connected') && orders === 0 && items === 0, 'switching to another store clears the old store\'s orders and stock');
    check((await row(b.id)).shopify_shop_domain === SHOP_2, 'now on the new store');

    console.log('\n8. Privacy (GDPR) webhooks');
    const [o1] = await pool.query(
      "INSERT INTO orders (seller_id, shopify_order_id, order_number, status, buyer_name, total_amount) VALUES (?, '9001', '#P1', 'unfulfilled', 'Maria Santos', 20)",
      [b.id]
    );
    await pool.query(
      "INSERT INTO orders (seller_id, shopify_order_id, order_number, status, buyer_name) VALUES (?, '9002', '#P2', 'unfulfilled', 'Other Buyer')",
      [b.id]
    );
    await pool.query(
      "INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken) VALUES (?, ?, '#P1', 'FULFILL - Maria Santos ordered 1 item', 'fulfill')",
      [b.id, o1.insertId]
    );
    const privacyHook = (topic, payload) => {
      const raw = JSON.stringify(payload);
      return http('POST', '/api/webhooks/compliance', {
        body: raw,
        headers: {
          'X-Shopify-Hmac-Sha256': crypto.createHmac('sha256', SECRET).update(raw).digest('base64'),
          'X-Shopify-Shop-Domain': payload.shop_domain,
          'X-Shopify-Topic': topic,
          'X-Shopify-Webhook-Id': crypto.randomUUID(),
        },
      });
    };

    const unsigned = await http('POST', '/api/webhooks/compliance', { body: '{}', headers: { 'X-Shopify-Hmac-Sha256': 'x', 'X-Shopify-Topic': 'shop/redact' } });
    check(unsigned.status === 401, 'unsigned privacy webhook -> 401 (what Shopify\'s review checks for)', `HTTP ${unsigned.status}`);

    const dataReq = await privacyHook('customers/data_request', {
      shop_domain: SHOP_2,
      customer: { id: 555, email: 'maria@example.test' },
      orders_requested: [9001],
      data_request: { id: 77 },
    });
    const requests = await http('GET', '/api/settings/privacy-requests', { token: b.token });
    const req0 = requests.json?.requests?.[0];
    check(dataReq.status === 200 && req0?.data_request_id === 77 && req0.data.orders[0]?.buyer_name === 'Maria Santos' && req0.data.decisions.length === 1, 'data request logged; Settings can show what we hold for it');
    const [[logged]] = await pool.query("SELECT details FROM privacy_requests WHERE seller_id = ? AND topic = 'customers/data_request'", [b.id]);
    check(!JSON.stringify(logged.details).includes('maria@'), 'the log holds ids, not the customer\'s email');

    const redact = await privacyHook('customers/redact', { shop_domain: SHOP_2, customer: { id: 555 }, orders_to_redact: [9001] });
    const [[p1]] = await pool.query("SELECT buyer_name FROM orders WHERE seller_id = ? AND shopify_order_id = '9001'", [b.id]);
    const [[p2]] = await pool.query("SELECT buyer_name FROM orders WHERE seller_id = ? AND shopify_order_id = '9002'", [b.id]);
    const [[d1]] = await pool.query("SELECT reasoning FROM decisions WHERE seller_id = ? AND order_number = '#P1'", [b.id]);
    check(redact.status === 200 && p1.buyer_name === 'Redacted' && p2.buyer_name === 'Other Buyer', 'customers/redact removes that buyer only');
    check(d1.reasoning === 'FULFILL - [redacted] ordered 1 item', 'and scrubs their name from decisions', d1.reasoning);

    const keep = await privacyHook('shop/redact', { shop_domain: SHOP_2, shop_id: 1 });
    const [[{ stillThere }]] = await pool.query('SELECT COUNT(*) AS stillThere FROM orders WHERE seller_id = ?', [b.id]);
    check(keep.status === 200 && stillThere === 2, 'shop/redact for a store that is connected again keeps its data');

    await http('DELETE', '/api/store', { token: b.token });
    const wipe = await privacyHook('shop/redact', { shop_domain: SHOP_2, shop_id: 1 });
    const [[{ left }]] = await pool.query(
      'SELECT (SELECT COUNT(*) FROM orders WHERE seller_id = ?) + (SELECT COUNT(*) FROM decisions WHERE seller_id = ?) AS `left`',
      [b.id, b.id]
    );
    const [[acct]] = await pool.query('SELECT email, shopify_shop_domain FROM sellers WHERE id = ?', [b.id]);
    check(wipe.status === 200 && left === 0 && acct.shopify_shop_domain === null && acct.email, 'shop/redact after uninstall deletes the store\'s data, keeps the login');
    const unknownTopic = await privacyHook('customers/whatever', { shop_domain: SHOP_2 });
    check(unknownTopic.status === 400, 'unknown compliance topic -> 400');

    console.log('\n9. Low-stock thresholds');
    const inventoryModel = require('../src/models/inventoryModel');
    const defaults = await http('PUT', '/api/settings/inventory', { token: a.token, body: { default_low_stock_threshold: 12 } });
    check(defaults.status === 200 && defaults.json.inventory.default_low_stock_threshold === 12, 'seller default saved');
    await inventoryModel.upsertInventoryItem(a.id, { productId: 'p1', variantId: 'v1', inventoryItemId: 'i1', itemName: 'Mug', stock: 10 }, 12);
    await inventoryModel.upsertInventoryItem(a.id, { productId: 'p2', variantId: 'v2', inventoryItemId: 'i2', itemName: 'Tote', stock: 40 }, 12);
    const list = await http('GET', '/api/inventory', { token: a.token });
    const [mug, tote] = list.json.items;
    check(mug?.item_name === 'Mug' && mug.low_stock_threshold === 12 && mug.is_low === true && tote.is_low === false, 'new items start at the default; low ones listed first');

    const patched = await http('PATCH', `/api/inventory/${mug.id}`, { token: a.token, body: { low_stock_threshold: 3 } });
    check(patched.status === 200 && patched.json.item.low_stock_threshold === 3 && patched.json.item.is_low === false, 'per-item threshold saved (Mug no longer low)');
    await inventoryModel.upsertInventoryItem(a.id, { productId: 'p1', variantId: 'v1', inventoryItemId: 'i1', itemName: 'Mug', stock: 9 }, 12);
    const [[mugRow]] = await pool.query('SELECT low_stock_threshold FROM inventory_items WHERE id = ?', [mug.id]);
    check(mugRow.low_stock_threshold === 3, 'a later sync keeps the seller\'s own threshold');

    for (const bad of [-1, 1.5, 'abc', null]) {
      const r = await http('PATCH', `/api/inventory/${mug.id}`, { token: a.token, body: { low_stock_threshold: bad } });
      if (r.status !== 400) check(false, `threshold ${JSON.stringify(bad)} rejected`, `HTTP ${r.status}`);
    }
    check(true, 'negative, fractional and non-numeric thresholds rejected');
    const otherSeller = await http('PATCH', `/api/inventory/${mug.id}`, { token: b.token, body: { low_stock_threshold: 1 } });
    check(otherSeller.status === 404, "another seller can't change it", `HTTP ${otherSeller.status}`);

    const applyAll = await http('PUT', '/api/settings/inventory', { token: a.token, body: { default_low_stock_threshold: 8, apply_to_all: true } });
    const [thresholds] = await pool.query('SELECT DISTINCT low_stock_threshold AS t FROM inventory_items WHERE seller_id = ?', [a.id]);
    check(applyAll.json.items_updated === 2 && thresholds.length === 1 && thresholds[0].t === 8, 'apply to all resets every item');
    const settingsInv = await http('GET', '/api/settings', { token: a.token });
    check(settingsInv.json.inventory.default_low_stock_threshold === 8, 'settings shows the default');
  } finally {
    for (const id of created) {
      for (const table of ['api_keys', 'decisions', 'orders', 'inventory_items', 'oauth_states', 'privacy_requests']) {
        await pool.query(`DELETE FROM ${table} WHERE seller_id = ?`, [id]);
      }
      await pool.query('DELETE FROM sellers WHERE id = ?', [id]);
    }
    console.log('\nRemoved the test sellers.');
  }
}

const server = app.listen(0, () => {
  base = `http://localhost:${server.address().port}`;
  main()
    .catch((err) => {
      console.error(`\nERROR: ${err.stack || err.message}`);
      failures++;
    })
    .finally(async () => {
      server.close();
      await pool.end();
      console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
      process.exit(failures ? 1 : 0);
    });
});
