const express = require('express');
const router = express.Router();
const verifyShopifyWebhook = require('../middleware/verifyShopifyWebhook');
const { handleOrderCreated } = require('../controllers/webhookController');

// Raw body (not parsed JSON) so the HMAC can be checked against the exact bytes Shopify sent.
router.use(express.raw({ type: 'application/json', limit: '1mb' }));
router.use(verifyShopifyWebhook); // no JWT here — the Shopify signature is the auth

router.post('/orders-create', handleOrderCreated);

module.exports = router;
