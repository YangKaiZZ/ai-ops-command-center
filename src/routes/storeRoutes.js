const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const { connectStore, disconnectStore } = require('../controllers/storeController');

// Changing which store (and token) an account uses needs a signed-in seller, not an API key.
router.use(requireAuth, requireSession);
router.post('/connect', connectStore);
router.delete('/', disconnectStore);

module.exports = router;
