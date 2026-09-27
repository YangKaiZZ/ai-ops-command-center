const chat = require('../services/chat');
const rateLimit = require('../services/rateLimit');

// GET /api/chat
// Whether chat can be used here, and how many of today's questions are left.
async function getChat(req, res) {
  try {
    res.json(await chat.status(req.sellerId));
  } catch (err) {
    console.error('[chat] status:', err.message);
    res.status(500).json({ error: 'Could not load chat' });
  }
}

// POST /api/chat  { messages: [{ role: 'user' | 'assistant', content }] }
// Answers the last question, with the conversation before it for context.
// Returns { reply, tools_used }.
async function postChat(req, res) {
  const { messages, error } = chat.validateMessages(req.body?.messages);
  if (error) return res.status(400).json({ error });
  if (!process.env.DEEPSEEK_API_KEY) {
    return res.status(503).json({ error: "Chat isn't set up on this server (no model key)." });
  }
  try {
    const wait = await chat.waitFor(req.sellerId);
    if (wait.seconds) {
      const what = wait.cap === 'account' ? `You've asked your ${chat.limits().perAccount.max} questions for today` : 'Chat is busy today';
      return rateLimit.tooManyRequests(res, wait.seconds, what);
    }
    res.json(await chat.answer(req.sellerId, messages));
  } catch (err) {
    console.error(`[chat seller=${req.sellerId}]`, err.status || '', err.message);
    res.status(502).json({ error: "Couldn't get an answer just now. Try again in a minute." });
  }
}

module.exports = { getChat, postChat };
