const rateLimit = require('./rateLimit');
// Called through the modules (not destructured), so tests can capture sends.
const email = require('./email');
const telegram = require('./telegram');

// Alerts to whoever runs this server (not to sellers): something broke that
// nobody would otherwise see until a seller complained. Sent to
//   OPS_ALERT_EMAIL             an address (needs SMTP_URL and EMAIL_FROM)
//   OPS_ALERT_TELEGRAM_CHAT_ID  a Telegram chat (needs TELEGRAM_BOT_TOKEN)
// With neither set, they're only logged. Each kind of alert (its key) goes out
// at most once per `repeatMinutes` (counted in the database, so a restart
// doesn't resend it); later ones in that window are only logged.

const DEFAULT_REPEAT_MINUTES = 60;

function destinations() {
  const address = (process.env.OPS_ALERT_EMAIL || '').trim();
  const chatId = (process.env.OPS_ALERT_TELEGRAM_CHAT_ID || '').trim();
  return {
    email: address && email.isEmailConfigured() ? address : null,
    chatId: chatId && telegram.isTelegramConfigured() ? chatId : null,
  };
}

function isConfigured() {
  const { email: address, chatId } = destinations();
  return Boolean(address || chatId);
}

// Sends `text` about `key` (e.g. "job:agent_run"), unless one went out for the
// same key within `repeatMinutes`. Never throws. Resolves to true when sent.
async function notifyOps(key, text, { repeatMinutes = DEFAULT_REPEAT_MINUTES } = {}) {
  console.warn(`[ops] ${text.split('\n')[0]}`);
  try {
    const { email: address, chatId } = destinations();
    if (!address && !chatId) return false;
    const limit = { bucket: 'ops-alert', max: 1, windowSeconds: Math.max(1, Math.round(repeatMinutes * 60)) };
    if (await rateLimit.secondsUntilAllowed(limit, key)) return false;
    await rateLimit.record(limit, key);

    const body = `${text}\n\n${new Date().toISOString()}`;
    const sends = [];
    if (chatId) sends.push(telegram.sendTelegramMessage(chatId, `Arbiter Ops server: ${body}`));
    if (address) sends.push(email.sendEmail({ to: address, subject: `Arbiter Ops server: ${text.split('\n')[0].slice(0, 120)}`, text: body }));
    const results = await Promise.allSettled(sends);
    for (const r of results) if (r.status === 'rejected') console.error(`[ops] sending an alert failed: ${r.reason?.message}`);
    return results.some((r) => r.status === 'fulfilled');
  } catch (err) {
    console.error(`[ops] alert "${key}" failed: ${err.message}`);
    return false;
  }
}

// Consecutive failed syncs per store, in memory: the alert comes on the
// SYNC_FAILURES_BEFORE_ALERT-th in a row, and a success resets it.
const SYNC_FAILURES_BEFORE_ALERT = 3;
const syncFailures = new Map();

async function recordSyncResult(sellerId, failures) {
  if (!failures.length) {
    syncFailures.delete(sellerId);
    return;
  }
  const count = (syncFailures.get(sellerId) || 0) + 1;
  syncFailures.set(sellerId, count);
  if (count === SYNC_FAILURES_BEFORE_ALERT) {
    await notifyOps(
      `sync:${sellerId}`,
      `Seller ${sellerId}'s store sync failed ${count} times in a row.\n${failures.join('\n')}`,
      { repeatMinutes: 6 * 60 }
    );
  }
}

module.exports = { notifyOps, isConfigured, recordSyncResult, SYNC_FAILURES_BEFORE_ALERT };
