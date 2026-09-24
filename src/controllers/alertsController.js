const channels = require('../models/channelModel');
const email = require('../services/email');
const telegram = require('../services/telegram');
const notifier = require('../services/notifier');
const { isEmail } = require('../utils/isEmail');

// Where alerts go besides the dashboard: email and Telegram (Slack is in
// settingsController). All under /api/settings, signed-in sellers only.

const MAX_CODES_PER_HOUR = 5;

// Settings-page status for both channels.
async function alertStatus(sellerId, { alertEmail, telegramConnected }) {
  return {
    email: {
      available: email.isEmailConfigured(),
      address: alertEmail || null,
      pending: await channels.pendingEmail(sellerId),
    },
    telegram: { available: telegram.isTelegramConfigured(), connected: Boolean(telegramConnected) },
  };
}

// PUT /api/settings/email   Body: { email }
// Sends a 6-digit code to the address. Alerts only go there once it's confirmed,
// so nobody can point them at someone else's inbox.
async function startEmail(req, res) {
  if (!email.isEmailConfigured()) return res.status(503).json({ error: "Email alerts aren't set up on this server yet." });
  const address = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!isEmail(address)) return res.status(400).json({ error: 'Enter a valid email address' });
  try {
    if ((await channels.recentCodeCount(req.sellerId, 'email')) >= MAX_CODES_PER_HOUR) {
      return res.status(429).json({ error: 'Too many codes sent. Try again in an hour.' });
    }
    const code = await channels.createLinkCode(req.sellerId, 'email', address);
    await email.sendEmail({
      to: address,
      subject: `Your AI Ops code: ${code}`,
      text: `Enter ${code} in AI Ops Settings to get alerts at this address.\n\nThe code works for 15 minutes. If you didn't ask for it, ignore this email.`,
    });
    res.json({ pending: address });
  } catch (err) {
    console.error(`[alerts] seller ${req.sellerId}: sending the email code failed: ${err.message}`);
    res.status(502).json({ error: "Couldn't send the email. Check the address and try again." });
  }
}

// POST /api/settings/email/verify   Body: { code }
async function verifyEmail(req, res) {
  try {
    const result = await channels.verifyEmailCode(req.sellerId, req.body?.code);
    const errors = {
      wrong: [400, "That code isn't right. Check the email and try again."],
      too_many: [429, 'Too many wrong codes. Send a new one.'],
      expired: [400, 'That code has expired. Send a new one.'],
      none: [400, 'Send a code first.'],
    };
    if (result.status !== 'ok') {
      const [status, error] = errors[result.status];
      return res.status(status).json({ error });
    }
    res.json({ email: { address: result.address } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not check the code' });
  }
}

// DELETE /api/settings/email   (also cancels a pending code)
async function removeEmail(req, res) {
  try {
    await channels.clearAlertEmail(req.sellerId);
    res.json({ email: { address: null } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not turn off email alerts' });
  }
}

// POST /api/settings/telegram
// A one-time link (15 minutes) that opens the bot; pressing Start links the chat.
async function startTelegram(req, res) {
  if (!telegram.isTelegramConfigured()) return res.status(503).json({ error: "Telegram alerts aren't set up on this server yet." });
  try {
    const code = await channels.createLinkCode(req.sellerId, 'telegram');
    const bot = await telegram.getBotUsername();
    res.json({ url: `https://t.me/${bot}?start=${code}`, expires_in_minutes: 15 });
  } catch (err) {
    console.error(`[alerts] seller ${req.sellerId}: Telegram link failed: ${err.response?.status || err.message}`);
    res.status(502).json({ error: "Couldn't reach Telegram. Try again." });
  }
}

// DELETE /api/settings/telegram
async function removeTelegram(req, res) {
  try {
    await channels.clearTelegram(req.sellerId);
    res.json({ telegram: { connected: false } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not turn off Telegram alerts' });
  }
}

// POST /api/settings/test-alert
// Sends a sample alert to every channel that's on, and says how each went.
async function testAlert(req, res) {
  try {
    const results = await notifier.postDecision(
      req.sellerId,
      '*Test alert*\nThis is how AI Ops alerts will look.\n- New orders: FULFILL or HOLD, with the reasons\n- Items that run low: RESTOCK'
    );
    if (!results.length) return res.status(400).json({ error: 'Turn on at least one alert channel first.' });
    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not send the test alert' });
  }
}

module.exports = { alertStatus, startEmail, verifyEmail, removeEmail, startTelegram, removeTelegram, testAlert };
