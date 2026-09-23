const pool = require('../config/db');
const { upsertOrder } = require('../models/orderModel');
const { triggerAgent } = require('../services/agentService');

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

// POST /api/webhooks/orders-create
// Trigger #1: Shopify calls this on every new order (signature already verified).
async function handleOrderCreated(req, res) {
  let order;
  try {
    order = JSON.parse(req.body.toString('utf8'));
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
    const [rows] = await pool.query('SELECT id FROM sellers WHERE shopify_shop_domain = ?', [shopDomain]);
    const seller = rows[0];
    if (!seller) {
      // Signed by our app but not a connected store: acknowledge so Shopify stops retrying.
      console.warn(`[webhook] orders/create for unknown shop ${shopDomain} - ignored`);
      return res.json({ received: true, ignored: true });
    }

    // Store it first so get_pending_orders already sees it when the agent runs.
    await upsertOrder(seller.id, order);
    markSeen(webhookId);
    res.json({ received: true });

    triggerAgent(seller.id, { type: 'order_created', order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not process webhook' }); // non-2xx -> Shopify retries later
  }
}

module.exports = { handleOrderCreated };
