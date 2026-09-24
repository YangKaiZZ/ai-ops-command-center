const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { JWT_SECRET } = require('../config/secrets');

// POST /api/auth/register
// Creates a new seller (tenant). Password is hashed, never stored plain.
async function register(req, res) {
  try {
    const { business_name, email, password } = req.body;
    if (!business_name || !email || !password) {
      return res.status(400).json({ error: 'business_name, email, and password are required' });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      'INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, ?)',
      [business_name, email, password_hash]
    );

    const token = jwt.sign({ sellerId: result.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, sellerId: result.insertId });
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
    const { email, password } = req.body;
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

module.exports = { register, login };
