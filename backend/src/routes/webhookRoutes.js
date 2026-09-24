const express = require('express');
const router = express.Router();
const verifyShopifyWebhook = require('../middleware/verifyShopifyWebhook');
const {
  handleOrderCreated,
  handleOrderUpdated,
  handleInventoryLevelUpdate,
  handleAppUninstalled,
  handlePrivacyWebhook,
} = require('../controllers/webhookController');

// Raw body (not parsed JSON) so the HMAC can be checked against the exact bytes Shopify sent.
router.use(express.raw({ type: 'application/json', limit: '1mb' }));
router.use(verifyShopifyWebhook); // no JWT here — the Shopify signature is the auth

// Paths match the topics registered by scripts/register-webhooks.js.
router.post('/orders-create', handleOrderCreated);
router.post('/orders-updated', handleOrderUpdated);
router.post('/inventory-levels-update', handleInventoryLevelUpdate);
router.post('/app-uninstalled', handleAppUninstalled);
router.post('/compliance', handlePrivacyWebhook); // customers/data_request, customers/redact, shop/redact

module.exports = router;
