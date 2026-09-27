const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireSession = require('../middleware/requireSession');
const notInDemo = require('../middleware/notInDemo');
const { getChat, postChat } = require('../controllers/chatController');

// A signed-in seller only: each question costs model calls, so API keys
// can't use it, and the demo (no model calls) has it off.
router.use(requireAuth, requireSession, notInDemo);
router.get('/', getChat);
router.post('/', postChat);

module.exports = router;
