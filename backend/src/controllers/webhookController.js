const { upsertOrder } = require('../models/orderModel');
const { findSellerByShopDomain, clearShopifyToken } = require('../models/sellerModel');
const { queueAgentRun } = require('../services/agentService');
const { enqueue } = require('../services/jobQueue');
const webhookDeliveries = require('../models/webhookDeliveryModel');
const privacy = require('../models/privacyModel');

// Shared by every topic (signature already verified): parse the body, drop
// repeats, find which seller's store sent it, then run `handle`. Anything
// slow goes on the job queue instead of being awaited: Shopify wants a reply
// within 5s.
//
// Shopify delivers at-least-once, so the same webhook can arrive twice. Its
// delivery id is recorded (in the database, so it holds across restarts) only
// once `handle` succeeds, so a failed attempt (500) can still be retried.
function webhookHandler(topic, handle) {
  return async (req, res) => {
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const webhookId = req.get('X-Shopify-Webhook-Id');
    try {
      if (webhookId && (await webhookDeliveries.isHandled(webhookId))) {
        return res.json({ received: true, duplicate: true });
      }

      // No JWT on webhooks — the shop domain header tells us which seller this is.
      const shopDomain = req.get('X-Shopify-Shop-Domain');
      const seller = await findSellerByShopDomain(shopDomain);
      if (!seller) {
        // Signed by our app but not a connected store: acknowledge so Shopify stops retrying.
        console.warn(`[webhook] ${topic} for unknown shop ${shopDomain} - ignored`);
        return res.json({ received: true, ignored: true });
      }

      await handle(seller.id, payload);
      if (webhookId) await webhookDeliveries.markHandled(webhookId, topic);
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
  // If queueing fails, the 500 makes Shopify send the order again.
  await upsertOrder(sellerId, order);
  await queueAgentRun(sellerId, { type: 'order_created', order });
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
  await enqueue('refresh_inventory_item', sellerId, { inventoryItemId: String(level.inventory_item_id) });
});

// POST /api/webhooks/app-uninstalled
// The merchant removed the app (or we revoked it): the token no longer works.
// The shop domain is kept so the privacy webhooks that follow still find this seller.
const handleAppUninstalled = webhookHandler('app/uninstalled', async (sellerId) => {
  await clearShopifyToken(sellerId);
  console.log(`[webhook] app uninstalled: seller ${sellerId}'s store is now disconnected`);
});

// --- Privacy (GDPR) webhooks, mandatory for apps on the Shopify App Store ---
// Every request is logged in privacy_requests (ids only, no personal data).

const handleCustomerDataRequest = webhookHandler('customers/data_request', async (sellerId, body) => {
  const orderIds = (body.orders_requested || []).map(String);
  await privacy.recordPrivacyRequest(sellerId, 'customers/data_request', body.shop_domain, {
    data_request_id: body.data_request?.id ?? null,
    customer_id: body.customer?.id ?? null,
    order_ids: orderIds,
  });
  console.log(`[privacy] seller ${sellerId}: customer data request for ${orderIds.length} order(s) (see GET /api/settings/privacy-requests)`);
});

const handleCustomerRedact = webhookHandler('customers/redact', async (sellerId, body) => {
  const orderIds = (body.orders_to_redact || []).map(String);
  const redacted = await privacy.redactCustomer(sellerId, orderIds);
  await privacy.recordPrivacyRequest(sellerId, 'customers/redact', body.shop_domain, {
    customer_id: body.customer?.id ?? null,
    order_ids: orderIds,
    orders_redacted: redacted,
  });
  console.log(`[privacy] seller ${sellerId}: redacted the buyer on ${redacted} order(s)`);
});

const handleShopRedact = webhookHandler('shop/redact', async (sellerId, body) => {
  // Sent 48 hours after an uninstall. If the store was connected again since,
  // it's a current customer again: keep its data.
  const seller = await findSellerByShopDomain(body.shop_domain);
  if (seller?.connected) {
    await privacy.recordPrivacyRequest(sellerId, 'shop/redact', body.shop_domain, { skipped: 'store was reconnected' });
    console.log(`[privacy] seller ${sellerId}: shop/redact skipped, ${body.shop_domain} is connected again`);
    return;
  }
  const deleted = await privacy.redactShop(sellerId);
  await privacy.recordPrivacyRequest(sellerId, 'shop/redact', body.shop_domain, { deleted });
  console.log(`[privacy] seller ${sellerId}: deleted ${body.shop_domain}'s data ${JSON.stringify(deleted)}`);
});

const privacyHandlers = {
  'customers/data_request': handleCustomerDataRequest,
  'customers/redact': handleCustomerRedact,
  'shop/redact': handleShopRedact,
};

// POST /api/webhooks/compliance
// The single "compliance webhooks" URL in the app's configuration: all three
// topics arrive here, told apart by the X-Shopify-Topic header.
function handlePrivacyWebhook(req, res) {
  const handler = privacyHandlers[req.get('X-Shopify-Topic')];
  if (!handler) return res.status(400).json({ error: 'Unknown compliance topic' });
  return handler(req, res);
}

module.exports = {
  handleOrderCreated,
  handleOrderUpdated,
  handleInventoryLevelUpdate,
  handleAppUninstalled,
  handlePrivacyWebhook,
};
