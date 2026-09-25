const axios = require('axios');
const { getAlertChannels } = require('../models/channelModel');
const email = require('./email');
const telegram = require('./telegram');
const { ratingUrl } = require('./ratingLinks');

// Only Slack's own webhook host is allowed. The backend POSTs to this URL, so
// accepting any URL would let a seller make the server call internal addresses.
function isSlackWebhookUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.pathname.length > 1;
  } catch {
    return false;
  }
}

// Decisions are written for Slack ("*New order #1001*" in bold). Email and
// Telegram get plain text.
function plainText(text) {
  return text.replace(/\*/g, '');
}

// "New order #1001: HOLD" from the headline and the verdict line.
function subjectLine(text) {
  const [first = '', second = ''] = plainText(text).split('\n');
  const verdict = second.match(/^(FULFILL|HOLD|RESTOCK)\b/)?.[1];
  return verdict ? `${first.trim()}: ${verdict}` : first.trim() || 'AI Ops alert';
}

// The rating links for a decision the seller can rate (ratingLinks.js), or null.
function ratingFor(sellerId, decisionId) {
  if (!decisionId) return null;
  return { decisionId, up: ratingUrl(decisionId, sellerId, 'up'), down: ratingUrl(decisionId, sellerId, 'down') };
}

// What Slack gets: the text, and for a decision two buttons that open its
// rating page. (Incoming webhooks can't receive clicks, so they're links.)
function slackPayload(text, rating) {
  if (!rating) return { text };
  return {
    text, // the notification preview, and the fallback where blocks don't show
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } },
      {
        type: 'actions',
        elements: [
          { type: 'button', action_id: 'rate_up', text: { type: 'plain_text', text: 'Right call' }, url: rating.up },
          { type: 'button', action_id: 'rate_down', text: { type: 'plain_text', text: 'Wrong call' }, url: rating.down },
        ],
      },
    ],
  };
}

// An email body: plain text, the rating links for a decision, and a footer.
function emailBody(text, rating, businessName) {
  const rate = rating ? `\n\nWas this the right call?\nYes: ${rating.up}\nNo: ${rating.down}` : '';
  return `${plainText(text)}${rate}\n\n--\nSent by AI Ops for ${businessName}. Change where alerts go in Settings.`;
}

// Telegram's buttons answer in the chat itself (telegram.js handles the tap),
// so they carry the decision id rather than a link.
function telegramButtons(rating) {
  if (!rating) return undefined;
  return {
    inline_keyboard: [
      [
        { text: 'Right call', callback_data: `rate:${rating.decisionId}:up` },
        { text: 'Wrong call', callback_data: `rate:${rating.decisionId}:down` },
      ],
    ],
  };
}

// Sends a message to every channel this seller turned on in Settings: Slack,
// email, Telegram. One failing channel doesn't stop the others. With none set
// up it goes to the server console. An agent decision passes its decisionId
// (it's saved to the dashboard's log first), which adds buttons to rate it.
// Returns [{ channel, ok, error? }] for the channels that were tried.
async function postDecision(sellerId, text, { decisionId = null } = {}) {
  let targets;
  try {
    targets = await getAlertChannels(sellerId);
  } catch (err) {
    console.error(`[notifier] seller ${sellerId}: could not read alert settings: ${err.message}`);
  }

  const rating = ratingFor(sellerId, decisionId);
  const sends = [];
  if (targets?.slackUrl) {
    sends.push(['slack', () => axios.post(targets.slackUrl, slackPayload(text, rating), { timeout: 5000, maxRedirects: 0 })]);
  }
  if (targets?.email && email.isEmailConfigured()) {
    sends.push([
      'email',
      () => email.sendEmail({ to: targets.email, subject: `AI Ops: ${subjectLine(text)}`, text: emailBody(text, rating, targets.businessName) }),
    ]);
  }
  if (targets?.telegramChatId && telegram.isTelegramConfigured()) {
    sends.push(['telegram', () => telegram.sendTelegramMessage(targets.telegramChatId, plainText(text), { reply_markup: telegramButtons(rating) })]);
  }

  if (!sends.length) {
    console.log(`\n[alert seller=${sellerId}]\n${text}\n`);
    return [];
  }

  const results = await Promise.all(
    sends.map(async ([channel, send]) => {
      try {
        await send();
        return { channel, ok: true };
      } catch (err) {
        const error = err.response?.status ? `HTTP ${err.response.status}` : err.message;
        return { channel, ok: false, error };
      }
    })
  );

  const sent = results.filter((r) => r.ok).map((r) => r.channel);
  const failed = results.filter((r) => !r.ok);
  if (sent.length) console.log(`[notifier] seller ${sellerId}: sent to ${sent.join(', ')}: ${text.split('\n')[0]}`);
  for (const f of failed) console.error(`[notifier] seller ${sellerId}: ${f.channel} failed: ${f.error}`);
  // Nothing got through: at least keep it in the server log.
  if (!sent.length) console.log(`\n[alert seller=${sellerId}]\n${text}\n`);
  return results;
}

module.exports = { postDecision, isSlackWebhookUrl, plainText, subjectLine, slackPayload, emailBody, telegramButtons };
