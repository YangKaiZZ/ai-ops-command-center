const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const { connect, install, callback } = require('../controllers/shopifyController');

router.post('/connect', requireAuth, requireSession, connect);
// Shopify redirects the browser to these two; they're checked with Shopify's HMAC, not a login.
router.get('/install', install);
router.get('/callback', callback);

module.exports = router;
