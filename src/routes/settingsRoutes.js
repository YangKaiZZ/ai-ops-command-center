const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { getSettings, setSlack, clearSlack } = require('../controllers/settingsController');

router.use(requireAuth);
router.get('/', getSettings);
router.put('/slack', setSlack);
router.delete('/slack', clearSlack);

module.exports = router;
