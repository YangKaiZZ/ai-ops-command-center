const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { connectStore } = require('../controllers/storeController');

router.use(requireAuth);
router.post('/connect', connectStore);

module.exports = router;
