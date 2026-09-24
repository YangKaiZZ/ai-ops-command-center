const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const { getSettings, setSlack, clearSlack, listKeys, createKey, revokeKey } = require('../controllers/settingsController');

router.use(requireAuth, requireSession);
router.get('/', getSettings);
router.put('/slack', setSlack);
router.delete('/slack', clearSlack);
router.get('/api-keys', listKeys);
router.post('/api-keys', createKey);
router.delete('/api-keys/:id', revokeKey);

module.exports = router;
