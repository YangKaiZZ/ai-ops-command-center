const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { sendEmail, isEmailConfigured } = require('./email');

const TOKEN_TTL_MINUTES = 60;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function resetLink(token) {
  const base = (process.env.DASHBOARD_URL || 'http://localhost:3005').replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(token)}`;
}

// Makes a fresh link for the seller and emails it; older unused links stop working.
async function sendResetEmail(seller) {
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query('UPDATE password_resets SET used_at = NOW() WHERE seller_id = ? AND used_at IS NULL', [seller.id]);
  await pool.query(
    'INSERT INTO password_resets (seller_id, token_hash, expires_at) VALUES (?, ?, NOW() + INTERVAL ? MINUTE)',
    [seller.id, hashToken(token), TOKEN_TTL_MINUTES]
  );
  await sendEmail({
    to: seller.email,
    subject: 'AI Ops: reset your password',
    text:
      `Someone asked to reset the password for ${seller.business_name} on AI Ops Command Center.\n\n` +
      `Choose a new password here (the link works once and expires in ${TOKEN_TTL_MINUTES} minutes):\n${resetLink(token)}\n\n` +
      "If that wasn't you, ignore this email: your password stays as it is.\n",
  });
}

// Spends the token and sets the new password in one transaction. Returns the
// seller's email, or null when the token is unknown, used or expired.
async function resetPassword(token, newPassword) {
  const password_hash = await bcrypt.hash(newPassword, 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT pr.seller_id, s.email FROM password_resets pr JOIN sellers s ON s.id = pr.seller_id
       WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > NOW() FOR UPDATE`,
      [hashToken(token)]
    );
    if (!rows[0]) {
      await conn.rollback();
      return null;
    }
    const { seller_id, email } = rows[0];
    await conn.query('UPDATE password_resets SET used_at = NOW() WHERE seller_id = ? AND used_at IS NULL', [seller_id]);
    await conn.query('UPDATE sellers SET password_hash = ?, password_changed_at = NOW() WHERE id = ?', [password_hash, seller_id]);
    await conn.commit();
    return email;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { isEmailConfigured, sendResetEmail, resetPassword, hashToken, TOKEN_TTL_MINUTES };
