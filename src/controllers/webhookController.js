const { upsertOrder } = require('../models/orderModel');
const { findSellerByShopDomain, clearShopifyToken } = require('../models/sellerModel');
const { triggerAgent } = require('../services/agentService');
const { refreshInventoryItem } = require('../services/syncService');

// Shopify delivers at-least-once, so the same webhook can arrive twice.
// Remember recent delivery IDs so a retry doesn't post a second decision.
const seenWebhookIds = new Set();
const MAX_SEEN = 500;

// Only called once a delivery is fully handled, so a failed attempt (500)
// can still be retried by Shopify.
function markSeen(webhookId) {
  if (!webhookId) return;
  seenWebhookIds.add(webhookId);
  if (seenWebhookIds.size > MAX_SEEN) {
    seenWebhookIds.delete(seenWebhookIds.values().next().value); // Sets iterate oldest-first
  }
}

// Shared by every topic (signature already verified): parse the body, drop
// repeats, find which seller's store sent it, then run `handle`. Anything
// slow must be started by `handle`, not awaited: Shopify wants a reply within 5s.
function webhookHandler(topic, handle) {
  return async (req, res) => {
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const webhookId = req.get('X-Shopify-Webhook-Id');
    if (webhookId && seenWebhookIds.has(webhookId)) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      // No JWT on webhooks — the shop domain header tells us which seller this is.
      const shopDomain = req.get('X-Shopify-Shop-Domain');
      const seller = await findSellerByShopDomain(shopDomain);
      if (!seller) {
        // Signed by our app but not a connected store: acknowledge so Shopify stops retrying.
        console.warn(`[webhook] ${topic} for unknown shop ${shopDomain} - ignored`);
        return res.json({ received: true, ignored: true });
      }

      await handle(seller.id, payload);
      markSeen(webhookId);
      res.json({ received: true });
    } catch (err) {
      console.error(`[webhook] ${topic}:`, err);
      res.status(500).json({ error: 'Could not process webhook' }); // non-2xx -> Shopify retries later
    }
  };
}

// POST /api/webhooks/orders-create
// Trigger #1: Shopify calls this on every new order.
const handleOrderCreated = webhookHandler('orders/create', async (sellerId, order) => {
  // Store it first so get_pending_orders already sees it when the agent runs.
  await upsertOrder(sellerId, order);
  triggerAgent(sellerId, { type: 'order_created', order });
});

// POST /api/webhooks/orders-updated
// Keeps shipping/payment status current (fulfilled, paid, refunded...) without a sync.
const handleOrderUpdated = webhookHandler('orders/updated', async (sellerId, order) => {
  await upsertOrder(sellerId, order);
});

// POST /api/webhooks/inventory-levels-update
// Stock changed at one location. Re-reads that variant and alerts the agent
// if it just went low (trigger #2, same as a sync).
const handleInventoryLevelUpdate = webhookHandler('inventory_levels/update', async (sellerId, level) => {
  // Shopify has sent these without an item id for bulk edits; the scheduled sync covers those.
  if (level.inventory_item_id == null) return;
  const tag = `[webhook] inventory item ${level.inventory_item_id} seller=${sellerId}`;
  refreshInventoryItem(sellerId, level.inventory_item_id)
    .then((result) => console.log(`${tag}: ${result.status}${result.stock != null ? `, stock ${result.stock}` : ''}`))
    .catch((err) => console.error(`${tag}: refresh failed: ${err.response?.status || err.message}`));
});

// POST /api/webhooks/app-uninstalled
// The merchant removed the app (or we revoked it): the token no longer works.
// The shop domain is kept so the privacy webhooks that follow still find this seller.
const handleAppUninstalled = webhookHandler('app/uninstalled', async (sellerId) => {
  await clearShopifyToken(sellerId);
  console.log(`[webhook] app uninstalled: seller ${sellerId}'s store is now disconnected`);
});

module.exports = { handleOrderCreated, handleOrderUpdated, handleInventoryLevelUpdate, handleAppUninstalled };
