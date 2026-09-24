const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { getLowStock, getInventory, updateItem } = require('../controllers/inventoryController');
const { syncInventory } = require('../controllers/syncController');

router.use(requireAuth);
router.get('/', getInventory);
router.get('/low-stock', getLowStock);
router.patch('/:id', updateItem);
router.post('/sync', syncInventory);

module.exports = router;
