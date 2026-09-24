const pool = require('../config/db');
const sellers = require('../models/sellerModel');
const oauth = require('./shopifyOAuth');
const webhookSetup = require('./webhookSetup');
const syncService = require('./syncService');

// Everything that happens once we hold a working token for a store, whether
// it came from "Connect with Shopify" or a pasted custom-app token:
// save it, point the webhooks here, and import orders + products.
async function finishConnection(sellerId, shopDomain, token) {
  const [[before]] = await pool.query('SELECT shopify_shop_domain FROM sellers WHERE id = ?', [sellerId]);
  const switchingStores = before?.shopify_shop_domain && before.shopify_shop_domain !== shopDomain;

  await sellers.releaseShopDomain(shopDomain, sellerId);
  await sellers.saveShopifyConnection(sellerId, shopDomain, token);

  if (switchingStores) {
    // Orders and stock from the old store would mix with the new one's. They
    // come back from Shopify if the old store is reconnected; decisions stay
    // as history.
    await pool.query('DELETE FROM inventory_items WHERE seller_id = ?', [sellerId]);
    await pool.query('DELETE FROM orders WHERE seller_id = ?', [sellerId]);
  }
  if (switchingStores || !before?.shopify_shop_domain) await sellers.setOrdersSyncedAt(sellerId, null);

  const webhooks = await setUpWebhooks({ shopDomain, accessToken: token.accessToken });
  startInitialSync(sellerId);
  return { webhooks, missingScopes: token.scopes ? oauth.missingScopes(token.scopes) : [] };
}

// Returns { ok, failed: [topics], skipped?: reason }. Never throws: a store
// without webhooks still works, the scheduled sync just does the catching up.
async function setUpWebhooks(creds) {
  const { appUrl } = oauth.config();
  if (!webhookSetup.isPublicHttpsUrl(appUrl)) {
    return { ok: false, failed: [], skipped: 'APP_URL is not a public https URL, so Shopify cannot deliver webhooks here' };
  }
  try {
    const { results } = await webhookSetup.registerWebhooks(creds, appUrl);
    const failed = results.filter((r) => r.action === 'failed');
    for (const r of failed) console.warn(`[connect] ${creds.shopDomain} ${r.topic}: ${r.error}`);
    return { ok: failed.length === 0, failed: failed.map((r) => r.topic) };
  } catch (err) {
    console.warn(`[connect] ${creds.shopDomain}: webhook setup failed: ${err.response?.status || err.message}`);
    return { ok: false, failed: Object.keys(webhookSetup.WEBHOOK_TOPICS) };
  }
}

// First import, in the background: the seller lands on the dashboard while it runs.
function startInitialSync(sellerId) {
  (async () => {
    const results = [];
    for (const [label, sync] of [['orders', syncService.syncOrders], ['inventory', syncService.syncInventory]]) {
      try {
        results.push((await sync(sellerId)).message);
      } catch (err) {
        results.push(`${label} FAILED (${err.response?.status || err.message})`);
      }
    }
    console.log(`[connect] seller ${sellerId} first sync: ${results.join('; ')}`);
  })();
}

module.exports = { finishConnection, setUpWebhooks };
