const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../config/secrets');
const { isEmail } = require('../utils/isEmail');
const rateLimit = require('../services/rateLimit');

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

module.exports = { register, login, validateRegistration };
