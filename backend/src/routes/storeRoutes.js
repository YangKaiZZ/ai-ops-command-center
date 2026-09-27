const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const notInDemo = require('../middleware/notInDemo');
const { connectStore, disconnectStore } = require('../controllers/storeController');

// Changing which store (and token) an account uses needs a signed-in seller, not an API key.
router.use(requireAuth, requireSession, notInDemo); // a demo account has no real store to change
router.post('/connect', connectStore);
router.delete('/', disconnectStore);

module.exports = router;
