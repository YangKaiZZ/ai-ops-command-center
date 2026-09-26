const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const { getOrders, getPendingOrders, getOrder } = require('../controllers/ordersController');
const { getShopifyState, holdOrder, releaseHold, fulfillOrder } = require('../controllers/orderActionsController');
const { syncOrders } = require('../controllers/syncController');

router.use(requireAuth); // everything below this line requires a valid token

router.get('/', getOrders);
router.get('/pending', getPendingOrders);
router.post('/sync', syncOrders);
router.get('/:id(\\d+)', getOrder);
router.get('/:id(\\d+)/shopify', getShopifyState);
// Acting in Shopify needs a dashboard sign-in: API keys (Claude Desktop) can't.
router.post('/:id(\\d+)/hold', requireSession, holdOrder);
router.post('/:id(\\d+)/release', requireSession, releaseHold);
router.post('/:id(\\d+)/fulfill', requireSession, fulfillOrder);

module.exports = router;
