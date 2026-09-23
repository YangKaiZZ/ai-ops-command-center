const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { getLowStock } = require('../controllers/inventoryController');
const { syncInventory } = require('../controllers/syncController');

router.use(requireAuth);
router.get('/low-stock', getLowStock);
router.post('/sync', syncInventory);

module.exports = router;
