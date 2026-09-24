const axios = require('axios');
const { getAlertChannels } = require('../models/channelModel');
const email = require('./email');
const telegram = require('./telegram');

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

// Sends the agent's decision to every channel this seller turned on in
// Settings: Slack, email, Telegram. One failing channel doesn't stop the
// others. With none set up it goes to the server console. (The decision is
// always saved to the dashboard's log first.)
// Returns [{ channel, ok, error? }] for the channels that were tried.
async function postDecision(sellerId, text) {
  let targets;
  try {
    targets = await getAlertChannels(sellerId);
  } catch (err) {
    console.error(`[notifier] seller ${sellerId}: could not read alert settings: ${err.message}`);
  }

  const sends = [];
  if (targets?.slackUrl) {
    sends.push(['slack', () => axios.post(targets.slackUrl, { text }, { timeout: 5000, maxRedirects: 0 })]);
  }
  if (targets?.email && email.isEmailConfigured()) {
    const footer = `\n\n--\nSent by AI Ops for ${targets.businessName}. Change where alerts go in Settings.`;
    sends.push(['email', () => email.sendEmail({ to: targets.email, subject: `AI Ops: ${subjectLine(text)}`, text: plainText(text) + footer })]);
  }
  if (targets?.telegramChatId && telegram.isTelegramConfigured()) {
    sends.push(['telegram', () => telegram.sendTelegramMessage(targets.telegramChatId, plainText(text))]);
  }

  if (!sends.length) {
    console.log(`\n[agent decision seller=${sellerId}]\n${text}\n`);
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
  if (!sent.length) console.log(`\n[agent decision seller=${sellerId}]\n${text}\n`);
  return results;
}

module.exports = { postDecision, isSlackWebhookUrl, plainText, subjectLine };
