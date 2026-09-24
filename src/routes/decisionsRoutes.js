const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { getDecisions } = require('../controllers/decisionsController');

router.use(requireAuth);
router.get('/', getDecisions);

module.exports = router;
