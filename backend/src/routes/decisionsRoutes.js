const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const { getDecisions, putFeedback } = require('../controllers/decisionsController');

router.use(requireAuth);
router.get('/', getDecisions);
router.put('/:id/feedback', putFeedback);

module.exports = router;
