const mysql = require('mysql2/promise');
require('dotenv').config();

// A connection pool (not a single connection) — reuses connections
// instead of opening a new one per request. Standard for any real API.
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'ai_ops',
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;
