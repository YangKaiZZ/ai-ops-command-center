const axios = require('axios');
const channels = require('../models/channelModel');

// Telegram alerts through one bot for the whole app (make it with @BotFather):
//   TELEGRAM_BOT_TOKEN=123456:ABC...
// A seller links their chat from Settings: a one-time link opens the bot with
// /start <code>. The bot reads messages by long polling, so it works without
// a public URL. Only one running backend may poll a given bot at a time.

const POLL_TIMEOUT_S = 25;
let polling = false;
let botUsername = null;

function isTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

// TELEGRAM_API_BASE is only for tests (a fake Telegram).
function api(method, params = {}, timeoutMs = 15000) {
  const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  return axios
    .post(`${base}/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, params, { timeout: timeoutMs })
    .then((res) => res.data.result);
}

async function getBotUsername() {
  if (!botUsername) botUsername = (await api('getMe')).username;
  return botUsername;
}

// Plain text on purpose: Telegram's Markdown would choke on stray * or _ in
// product names.
async function sendTelegramMessage(chatId, text) {
  await api('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true });
}

// One incoming message.
async function handleUpdate(update) {
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = message?.chat?.id;
  if (!text || chatId == null) return;

  const [command, arg] = text.split(/\s+/, 2);
  if (command === '/start' && arg) {
    const linked = await channels.linkTelegramChat(arg, chatId);
    await sendTelegramMessage(
      chatId,
      linked
        ? `Connected to ${linked.businessName}. AI Ops alerts (new orders, low stock) will arrive here. Send /stop to turn them off.`
        : 'That link has expired or was already used. Get a new one from Settings in the AI Ops dashboard.'
    );
    if (linked) console.log(`[telegram] seller ${linked.sellerId} linked a chat`);
  } else if (command === '/stop') {
    const count = await channels.unlinkTelegramChat(chatId);
    await sendTelegramMessage(chatId, count ? 'Alerts turned off for this chat.' : 'This chat has no alerts turned on.');
  } else {
    await sendTelegramMessage(chatId, 'To get AI Ops alerts here, use the "Connect Telegram" link in Settings in the AI Ops dashboard.');
  }
}

async function pollLoop() {
  let offset = 0;
  while (polling) {
    try {
      const updates = await api('getUpdates', { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] }, (POLL_TIMEOUT_S + 10) * 1000);
      for (const update of updates) {
        offset = update.update_id + 1;
        await handleUpdate(update).catch((err) => console.error(`[telegram] update ${update.update_id}: ${err.message}`));
      }
    } catch (err) {
      if (!polling) break;
      const status = err.response?.status;
      console.error(`[telegram] polling failed: ${status ? `HTTP ${status}` : err.message}${status === 409 ? ' (another process is polling this bot)' : ''}`);
      await new Promise((resolve) => setTimeout(resolve, status === 401 ? 60000 : 5000));
    }
  }
}

function startTelegramPolling() {
  if (!isTelegramConfigured() || polling) return;
  polling = true;
  getBotUsername()
    .then((name) => console.log(`[telegram] bot @${name} is listening`))
    .catch((err) => console.error(`[telegram] getMe failed: ${err.response?.status || err.message}`));
  pollLoop();
}

function stopTelegramPolling() {
  polling = false;
}

module.exports = { isTelegramConfigured, getBotUsername, sendTelegramMessage, handleUpdate, startTelegramPolling, stopTelegramPolling };
