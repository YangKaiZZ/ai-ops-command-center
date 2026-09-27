const axios = require('axios');
const { getAlertChannels } = require('../models/channelModel');
const email = require('./email');
const telegram = require('./telegram');
const { ratingUrl } = require('./ratingLinks');
const { orderActionUrl, TTL_DAYS: ACTION_LINK_DAYS } = require('./actionLinks');
const orderActions = require('./orderActions');

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

// The links to hold or fulfill the order an alert is about (actionLinks.js),
// or null: no order, or the seller can't act on it from here (no store, or
// the store refused the permission).
async function actionsFor(sellerId, orderId) {
  if (!orderId) return null;
  try {
    if (!(await orderActions.actionsOffered(sellerId))) return null;
  } catch (err) {
    console.error(`[notifier] seller ${sellerId}: could not check whether it can act in Shopify: ${err.message}`);
    return null;
  }
  return { orderId, hold: orderActionUrl(orderId, sellerId, 'hold'), fulfill: orderActionUrl(orderId, sellerId, 'fulfill') };
}

// What Slack gets: the text, then for a decision two buttons that open its
// rating page, and for an order two that open a page to hold or fulfill it.
// (Incoming webhooks can't receive clicks, so they're links.)
function slackPayload(text, rating, actions = null) {
  if (!rating && !actions) return { text };
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } }];
  if (rating) {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'rate_up', text: { type: 'plain_text', text: 'Right call' }, url: rating.up },
        { type: 'button', action_id: 'rate_down', text: { type: 'plain_text', text: 'Wrong call' }, url: rating.down },
      ],
    });
  }
  if (actions) {
    blocks.push({
      type: 'actions',
      elements: [
        { type: 'button', action_id: 'shopify_hold', text: { type: 'plain_text', text: 'Hold in Shopify' }, url: actions.hold },
        { type: 'button', action_id: 'shopify_fulfill', text: { type: 'plain_text', text: 'Mark fulfilled' }, url: actions.fulfill },
      ],
    });
  }
  // text: the notification preview, and the fallback where blocks don't show
  return { text, blocks };
}

// An email body: plain text, the rating links for a decision, the hold and
// fulfill links for an order, and a footer.
function emailBody(text, rating, businessName, actions = null) {
  const rate = rating ? `\n\nWas this the right call?\nYes: ${rating.up}\nNo: ${rating.down}` : '';
  const act = actions
    ? `\n\nIn Shopify (each link opens a page to confirm, and works for ${ACTION_LINK_DAYS} days):\nPut on hold: ${actions.hold}\nMark fulfilled: ${actions.fulfill}`
    : '';
  return `${plainText(text)}${rate}${act}\n\n--\nSent by AI Ops for ${businessName}. Change where alerts go in Settings.`;
}

// Telegram's buttons answer in the chat itself (telegram.js handles the tap),
// so they carry the decision or order id rather than a link. Holding and
// fulfilling ask to confirm first.
function telegramButtons(rating, actions = null) {
  const rows = [];
  if (rating) {
    rows.push([
      { text: 'Right call', callback_data: `rate:${rating.decisionId}:up` },
      { text: 'Wrong call', callback_data: `rate:${rating.decisionId}:down` },
    ]);
  }
  if (actions) {
    rows.push([
      { text: 'Hold in Shopify', callback_data: `act:${actions.orderId}:hold` },
      { text: 'Mark fulfilled', callback_data: `act:${actions.orderId}:fulfill` },
    ]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

// Sends a message to every channel this seller turned on in Settings: Slack,
// email, Telegram. One failing channel doesn't stop the others. With none set
// up it goes to the server console. An agent decision passes its decisionId
// (it's saved to the dashboard's log first), which adds buttons to rate it;
// an alert about one order passes its orderId (ours), which adds buttons to
// hold or fulfill it in Shopify.
// Returns [{ channel, ok, error? }] for the channels that were tried.
async function postDecision(sellerId, text, { decisionId = null, orderId = null } = {}) {
  let targets;
  try {
    targets = await getAlertChannels(sellerId);
  } catch (err) {
    console.error(`[notifier] seller ${sellerId}: could not read alert settings: ${err.message}`);
  }

  const rating = ratingFor(sellerId, decisionId);
  const actions = targets ? await actionsFor(sellerId, orderId) : null;
  const sends = [];
  if (targets?.slackUrl) {
    sends.push(['slack', () => axios.post(targets.slackUrl, slackPayload(text, rating, actions), { timeout: 5000, maxRedirects: 0 })]);
  }
  if (targets?.email && email.isEmailConfigured()) {
    sends.push([
      'email',
      () =>
        email.sendEmail({ to: targets.email, subject: `AI Ops: ${subjectLine(text)}`, text: emailBody(text, rating, targets.businessName, actions) }),
    ]);
  }
  if (targets?.telegramChatId && telegram.isTelegramConfigured()) {
    sends.push([
      'telegram',
      () => telegram.sendTelegramMessage(targets.telegramChatId, plainText(text), { reply_markup: telegramButtons(rating, actions) }),
    ]);
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
