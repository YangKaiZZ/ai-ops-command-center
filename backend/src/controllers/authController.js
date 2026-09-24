const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../config/secrets');
const { isEmail } = require('../utils/isEmail');
const rateLimit = require('../services/rateLimit');
const passwordReset = require('../services/passwordReset');

const { LIMITS } = rateLimit;
const MIN_PASSWORD = 8;

// Compared against when the email has no account, so an unknown email takes
// as long to reject as a wrong password (the timing doesn't reveal accounts).
const NO_ACCOUNT_HASH = bcrypt.hashSync('no account has this password', 10);

// Checks the sign-up form; returns the cleaned values or an error message.
function validateRegistration(body) {
  const businessName = typeof body?.business_name === 'string' ? body.business_name.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!businessName || businessName.length > 255) return { error: 'Enter your business name' };
  if (!isEmail(email)) return { error: 'Enter a valid email address' };
  if (password.length < MIN_PASSWORD) return { error: `Use a password of at least ${MIN_PASSWORD} characters` };
  if (password.length > 200) return { error: 'That password is too long' };
  return { businessName, email, password };
}

// POST /api/auth/register
// Creates a new seller (tenant). Password is hashed, never stored plain.
async function register(req, res) {
  try {
    const input = validateRegistration(req.body);
    if (input.error) return res.status(400).json({ error: input.error });

    const limitedByIp = !rateLimit.isLoopback(req.ip);
    const wait = limitedByIp ? await rateLimit.secondsUntilAllowed(LIMITS.signupsPerIp, req.ip) : 0;
    if (wait) return rateLimit.tooManyRequests(res, wait, 'Too many new accounts from your network');

    const password_hash = await bcrypt.hash(input.password, 10);

    const [result] = await pool.query(
      'INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, ?)',
      [input.businessName, input.email, password_hash]
    );
    if (limitedByIp) await rateLimit.record(LIMITS.signupsPerIp, req.ip);

    const token = jwt.sign({ sellerId: result.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, sellerId: result.insertId, business_name: input.businessName });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong creating the account' });
  }
}

// POST /api/auth/login
// Too many failures for one email, or from one address, and sign-in pauses
// for that email or address (429) until older failures age out. An email
// without an account is limited the same way, so a 429 reveals nothing.
async function login(req, res) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const limitedByIp = !rateLimit.isLoopback(req.ip);

    const wait = Math.max(
      await rateLimit.secondsUntilAllowed(LIMITS.loginFailuresPerAccount, email),
      limitedByIp ? await rateLimit.secondsUntilAllowed(LIMITS.loginFailuresPerIp, req.ip) : 0
    );
    if (wait) return rateLimit.tooManyRequests(res, wait, 'Too many failed sign-in attempts');

    const [rows] = await pool.query('SELECT * FROM sellers WHERE email = ?', [email]);
    const seller = rows[0];
    const passwordMatches = await bcrypt.compare(password, seller?.password_hash ?? NO_ACCOUNT_HASH);

    if (!seller || !passwordMatches) {
      await rateLimit.record(LIMITS.loginFailuresPerAccount, email);
      if (limitedByIp) await rateLimit.record(LIMITS.loginFailuresPerIp, req.ip);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await rateLimit.clear(LIMITS.loginFailuresPerAccount, email); // the owner got in: start their count afresh

    const token = jwt.sign({ sellerId: seller.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, sellerId: seller.id, business_name: seller.business_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong logging in' });
  }
}

// POST /api/auth/forgot-password { email }
// Always answers the same (202) whether or not the email has an account, and
// counts every request against the limits, so it can't be used to find out
// who has one. The email is sent after answering, so timing doesn't tell either.
async function forgotPassword(req, res) {
  try {
    if (!passwordReset.isEmailConfigured()) {
      return res.status(503).json({ error: "Password reset by email isn't set up on this server. Ask its administrator." });
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    const limitedByIp = !rateLimit.isLoopback(req.ip);

    const wait = Math.max(
      await rateLimit.secondsUntilAllowed(LIMITS.resetRequestsPerAccount, email),
      limitedByIp ? await rateLimit.secondsUntilAllowed(LIMITS.resetRequestsPerIp, req.ip) : 0
    );
    if (wait) return rateLimit.tooManyRequests(res, wait, 'Too many password reset requests');
    await rateLimit.record(LIMITS.resetRequestsPerAccount, email);
    if (limitedByIp) await rateLimit.record(LIMITS.resetRequestsPerIp, req.ip);

    const [rows] = await pool.query('SELECT id, email, business_name FROM sellers WHERE email = ?', [email]);
    if (rows[0]) {
      passwordReset.sendResetEmail(rows[0]).catch((err) => console.error(`[auth] reset email for seller ${rows[0].id} failed: ${err.message}`));
    }
    res.status(202).json({ message: 'If that email has an account, a reset link is on its way. It works once and expires in an hour.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong sending the reset link' });
  }
}

// POST /api/auth/reset-password { token, password }
// Sets the new password, spends the token, and signs out everywhere else
// (older sign-in tokens stop working). Doesn't sign the caller in.
async function resetPassword(req, res) {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Use a password of at least ${MIN_PASSWORD} characters` });
    if (password.length > 200) return res.status(400).json({ error: 'That password is too long' });

    const limitedByIp = !rateLimit.isLoopback(req.ip);
    const wait = limitedByIp ? await rateLimit.secondsUntilAllowed(LIMITS.resetFailuresPerIp, req.ip) : 0;
    if (wait) return rateLimit.tooManyRequests(res, wait, 'Too many attempts with a bad reset link');

    const email = token.length >= 20 && token.length <= 100 ? await passwordReset.resetPassword(token, password) : null;
    if (!email) {
      if (limitedByIp) await rateLimit.record(LIMITS.resetFailuresPerIp, req.ip);
      return res.status(400).json({ error: 'This reset link is invalid or has expired. Ask for a new one.' });
    }
    await rateLimit.clear(LIMITS.loginFailuresPerAccount, email); // they've proved they own it: lift a lockout
    res.json({ message: 'Password changed. Sign in with the new one.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong resetting the password' });
  }
}

module.exports = { register, login, forgotPassword, resetPassword, validateRegistration };
