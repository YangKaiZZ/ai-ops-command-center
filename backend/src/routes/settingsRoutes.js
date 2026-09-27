const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const notInDemo = require('../middleware/notInDemo');
const {
  getSettings,
  setSlack,
  clearSlack,
  listKeys,
  createKey,
  revokeKey,
  privacyRequests,
  setInventoryDefaults,
  setAutoHoldSetting,
} = require('../controllers/settingsController');
const alerts = require('../controllers/alertsController');
const reports = require('../controllers/reportsController');

router.use(requireAuth, requireSession);
router.get('/', getSettings);
// Not in the demo: what sends messages or lets other tools in.
router.put('/slack', notInDemo, setSlack);
router.delete('/slack', clearSlack);
router.get('/api-keys', listKeys);
router.post('/api-keys', notInDemo, createKey);
router.delete('/api-keys/:id', revokeKey);
router.get('/privacy-requests', privacyRequests);
router.put('/inventory', setInventoryDefaults);
router.put('/auto-hold', setAutoHoldSetting);
router.put('/email', notInDemo, alerts.startEmail);
router.post('/email/verify', notInDemo, alerts.verifyEmail);
router.delete('/email', alerts.removeEmail);
router.post('/telegram', notInDemo, alerts.startTelegram);
router.delete('/telegram', alerts.removeTelegram);
router.post('/test-alert', notInDemo, alerts.testAlert);
router.put('/reports', reports.saveReports);
router.post('/reports/summary', notInDemo, reports.sendSummaryNow);

module.exports = router;
