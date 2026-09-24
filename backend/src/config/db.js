const mysql = require('mysql2/promise');
const { dbSettings } = require('./dbSettings');

// A connection pool (not a single connection) — reuses connections
// instead of opening a new one per request. Standard for any real API.
const pool = mysql.createPool({
  ...dbSettings(),
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;
