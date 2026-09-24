const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../config/secrets');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// Checks the sign-up form; returns the cleaned values or an error message.
function validateRegistration(body) {
  const businessName = typeof body?.business_name === 'string' ? body.business_name.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!businessName || businessName.length > 255) return { error: 'Enter your business name' };
  if (!EMAIL_RE.test(email) || email.length > 255) return { error: 'Enter a valid email address' };
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

    const password_hash = await bcrypt.hash(input.password, 10);

    const [result] = await pool.query(
      'INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, ?)',
      [input.businessName, input.email, password_hash]
    );

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
async function login(req, res) {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const [rows] = await pool.query('SELECT * FROM sellers WHERE email = ?', [email]);
    const seller = rows[0];

    if (!seller || !(await bcrypt.compare(password, seller.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ sellerId: seller.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, sellerId: seller.id, business_name: seller.business_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong logging in' });
  }
}

module.exports = { register, login, validateRegistration };
