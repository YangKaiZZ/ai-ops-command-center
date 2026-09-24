const crypto = require('crypto');
const pool = require('../config/db');
const { decryptSecret } = require('../config/secrets');

// Where a seller's alerts go besides the dashboard: Slack (sellerModel),
// a verified email address, and a linked Telegram chat.
//
// Both email and Telegram are linked with a short-lived code (channel_links):
// email sends a 6-digit code to the address, Telegram puts a one-time code in
// the bot link. Only a hash of each code is stored.

const CODE_TTL_MINUTES = 15;
const MAX_EMAIL_ATTEMPTS = 5;

function hashCode(channel, code) {
  return crypto.createHash('sha256').update(`${channel}:${code}`).digest('hex');
}

async function recentCodeCount(sellerId, channel) {
  const [[{ n }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM channel_links WHERE seller_id = ? AND channel = ? AND created_at > NOW() - INTERVAL 1 HOUR',
    [sellerId, channel]
  );
  return n;
}

// Starts linking a channel. Returns the code. Earlier codes stay in the table
// (so the per-hour limit can count them), but only the newest email code is
// accepted; a day after expiring, rows are cleared.
async function createLinkCode(sellerId, channel, target = null) {
  const code =
    channel === 'email'
      ? String(crypto.randomInt(0, 1000000)).padStart(6, '0')
      : crypto.randomBytes(12).toString('base64url'); // fits Telegram's start parameter (A-Z a-z 0-9 _ -)
  await pool.query('DELETE FROM channel_links WHERE expires_at < NOW() - INTERVAL 1 DAY');
  await pool.query(
    'INSERT INTO channel_links (seller_id, channel, target, code_hash, expires_at) VALUES (?, ?, ?, ?, NOW() + INTERVAL ? MINUTE)',
    [sellerId, channel, target, hashCode(channel, code), CODE_TTL_MINUTES]
  );
  return code;
}

// The newest email code for this seller, if any.
async function latestEmailLink(sellerId) {
  const [rows] = await pool.query(
    `SELECT id, target, code_hash, attempts, expires_at > NOW() AS live FROM channel_links
     WHERE seller_id = ? AND channel = 'email' ORDER BY id DESC LIMIT 1`,
    [sellerId]
  );
  return rows[0] || null;
}

// The address waiting for its code to be entered, or null.
async function pendingEmail(sellerId) {
  const link = await latestEmailLink(sellerId);
  return link && link.live && link.attempts < MAX_EMAIL_ATTEMPTS ? link.target : null;
}

// Checks a 6-digit code. Returns { status: 'ok', address } | { status: 'wrong' | 'expired' | 'too_many' | 'none' }.
async function verifyEmailCode(sellerId, code) {
  const link = await latestEmailLink(sellerId);
  if (!link) return { status: 'none' };
  if (!link.live) return { status: 'expired' };
  if (link.attempts >= MAX_EMAIL_ATTEMPTS) return { status: 'too_many' };

  const given = Buffer.from(hashCode('email', String(code || '').trim()), 'utf8');
  const expected = Buffer.from(link.code_hash, 'utf8');
  if (!crypto.timingSafeEqual(given, expected)) {
    await pool.query('UPDATE channel_links SET attempts = attempts + 1 WHERE id = ?', [link.id]);
    return { status: link.attempts + 1 >= MAX_EMAIL_ATTEMPTS ? 'too_many' : 'wrong' };
  }
  await pool.query('UPDATE sellers SET alert_email = ? WHERE id = ?', [link.target, sellerId]);
  await expireEmailCodes(sellerId);
  return { status: 'ok', address: link.target };
}

// Codes are expired, not deleted, so they still count toward the hourly limit
// (otherwise cancel-and-resend could spam an address with code emails).
async function expireEmailCodes(sellerId) {
  await pool.query(
    "UPDATE channel_links SET expires_at = NOW() - INTERVAL 1 SECOND WHERE seller_id = ? AND channel = 'email' AND expires_at > NOW()",
    [sellerId]
  );
}

async function clearAlertEmail(sellerId) {
  await pool.query('UPDATE sellers SET alert_email = NULL WHERE id = ?', [sellerId]);
  await expireEmailCodes(sellerId);
}

// Telegram: the bot received /start <code>. Links that chat to the seller
// who made the code and returns { sellerId, businessName }, or null.
async function linkTelegramChat(code, chatId) {
  const [rows] = await pool.query(
    "SELECT l.id, l.seller_id, s.business_name FROM channel_links l JOIN sellers s ON s.id = l.seller_id WHERE l.channel = 'telegram' AND l.code_hash = ? AND l.expires_at > NOW()",
    [hashCode('telegram', code)]
  );
  const link = rows[0];
  if (!link) return null;
  const [result] = await pool.query('DELETE FROM channel_links WHERE id = ?', [link.id]); // one use
  if (result.affectedRows !== 1) return null;
  // Any other link this seller made is no longer needed.
  await pool.query("DELETE FROM channel_links WHERE seller_id = ? AND channel = 'telegram' AND expires_at > NOW()", [link.seller_id]);
  await pool.query('UPDATE sellers SET telegram_chat_id = ? WHERE id = ?', [String(chatId), link.seller_id]);
  return { sellerId: link.seller_id, businessName: link.business_name };
}

// /stop in the chat, or "Disconnect" in Settings. Returns how many accounts were unlinked.
async function unlinkTelegramChat(chatId) {
  const [result] = await pool.query('UPDATE sellers SET telegram_chat_id = NULL WHERE telegram_chat_id = ?', [String(chatId)]);
  return result.affectedRows;
}

async function clearTelegram(sellerId) {
  await pool.query('UPDATE sellers SET telegram_chat_id = NULL WHERE id = ?', [sellerId]);
  await pool.query("DELETE FROM channel_links WHERE seller_id = ? AND channel = 'telegram'", [sellerId]);
}

// Everywhere this seller's alerts should go.
async function getAlertChannels(sellerId) {
  const [rows] = await pool.query(
    'SELECT business_name, slack_webhook_url, alert_email, telegram_chat_id FROM sellers WHERE id = ?',
    [sellerId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    businessName: row.business_name,
    slackUrl: decryptSecret(row.slack_webhook_url),
    email: row.alert_email,
    telegramChatId: row.telegram_chat_id,
  };
}

module.exports = {
  MAX_EMAIL_ATTEMPTS,
  recentCodeCount,
  createLinkCode,
  pendingEmail,
  verifyEmailCode,
  clearAlertEmail,
  linkTelegramChat,
  unlinkTelegramChat,
  clearTelegram,
  getAlertChannels,
};
