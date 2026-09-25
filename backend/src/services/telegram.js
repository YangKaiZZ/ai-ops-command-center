const axios = require('axios');
const channels = require('../models/channelModel');
const decisions = require('../models/decisionModel');

const { NOTE_MAX_LENGTH } = decisions;

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
// product names. `extra` adds sendMessage options, e.g. reply_markup buttons.
async function sendTelegramMessage(chatId, text, extra = {}) {
  await api('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });
}

const RATED = { up: 'right call', down: 'wrong call' };
// The bot's question after a "Wrong call" tap ends with this, so a reply to it
// can be matched to the decision without keeping any state.
const noteTag = (decisionId) => `(decision #${decisionId})`;
const NOTE_TAG = /\(decision #(\d+)\)$/;

// The two rating buttons under a decision alert, the chosen one ticked.
function ratedButtons(decisionId, feedback) {
  const label = (value, text) => (feedback === value ? `✓ ${text}` : text);
  return {
    inline_keyboard: [
      [
        { text: label('up', 'Right call'), callback_data: `rate:${decisionId}:up` },
        { text: label('down', 'Wrong call'), callback_data: `rate:${decisionId}:down` },
      ],
    ],
  };
}

// A tap on "Right call" / "Wrong call" under a decision alert. It only counts
// from the chat linked to the account the decision belongs to.
async function handleRatingTap(query) {
  const [, id, value] = String(query.data || '').match(/^rate:(\d{1,12}):(up|down)$/) || [];
  const chatId = query.message?.chat?.id;
  const decision = id && chatId != null ? await decisions.decisionForTelegramChat(Number(id), chatId) : null;
  if (!decision || decision.action_taken === 'skipped') {
    await api('answerCallbackQuery', { callback_query_id: query.id, text: "This chat can't rate that decision." });
    return;
  }
  // A new rating keeps the note the seller already wrote.
  const saved = await decisions.setFeedback(decision.seller_id, Number(id), { feedback: value, note: decision.feedback_note });
  await api('answerCallbackQuery', { callback_query_id: query.id, text: `Saved: ${RATED[value]}` });
  await api('editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: query.message.message_id,
    reply_markup: ratedButtons(Number(id), saved.feedback),
  }).catch(() => {}); // the message may be too old to edit; the rating is saved either way
  if (value === 'down' && !saved.feedback_note) {
    await sendTelegramMessage(
      chatId,
      `What should it have done? Reply to this message with a few words, and the agent will read them before similar decisions. ${noteTag(id)}`,
      { reply_markup: { force_reply: true, input_field_placeholder: 'What should it have done?' } }
    );
  }
}

// A reply to the bot's "What should it have done?" question: the note for
// that decision. Returns false when the message isn't one.
async function handleNoteReply(message, text) {
  const id = message.reply_to_message?.from?.is_bot && message.reply_to_message.text?.match(NOTE_TAG)?.[1];
  if (!id) return false;
  const decision = await decisions.decisionForTelegramChat(Number(id), message.chat.id);
  if (!decision || decision.action_taken === 'skipped') {
    await sendTelegramMessage(message.chat.id, "This chat can't add a note to that decision.");
    return true;
  }
  const note = text.slice(0, NOTE_MAX_LENGTH);
  await decisions.setFeedback(decision.seller_id, Number(id), { feedback: decision.feedback || 'down', note });
  await sendTelegramMessage(message.chat.id, 'Thanks, noted. The agent will read it before similar decisions.');
  return true;
}

// One incoming update: a message, or a tap on a rating button.
async function handleUpdate(update) {
  if (update.callback_query) return handleRatingTap(update.callback_query);
  const message = update.message;
  const text = message?.text?.trim();
  const chatId = message?.chat?.id;
  if (!text || chatId == null) return;
  if (await handleNoteReply(message, text)) return;

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
      const updates = await api(
        'getUpdates',
        { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
        (POLL_TIMEOUT_S + 10) * 1000
      );
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
