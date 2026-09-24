const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const {
  getSettings,
  setSlack,
  clearSlack,
  listKeys,
  createKey,
  revokeKey,
  privacyRequests,
  setInventoryDefaults,
} = require('../controllers/settingsController');
const alerts = require('../controllers/alertsController');

router.use(requireAuth, requireSession);
router.get('/', getSettings);
router.put('/slack', setSlack);
router.delete('/slack', clearSlack);
router.get('/api-keys', listKeys);
router.post('/api-keys', createKey);
router.delete('/api-keys/:id', revokeKey);
router.get('/privacy-requests', privacyRequests);
router.put('/inventory', setInventoryDefaults);
router.put('/email', alerts.startEmail);
router.post('/email/verify', alerts.verifyEmail);
router.delete('/email', alerts.removeEmail);
router.post('/telegram', alerts.startTelegram);
router.delete('/telegram', alerts.removeTelegram);
router.post('/test-alert', alerts.testAlert);

module.exports = router;
