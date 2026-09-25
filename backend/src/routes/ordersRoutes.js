const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { getOrders, getPendingOrders, getOrder } = require('../controllers/ordersController');
const { syncOrders } = require('../controllers/syncController');

router.use(requireAuth); // everything below this line requires a valid token

router.get('/', getOrders);
router.get('/pending', getPendingOrders);
router.post('/sync', syncOrders);
router.get('/:id(\\d+)', getOrder);

module.exports = router;
