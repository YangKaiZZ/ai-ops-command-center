require('dotenv').config({ quiet: true });

// Where the database is, for the app's pool (db.js) and the migrator.
function dbSettings() {
  return {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'ai_ops',
  };
}

module.exports = { dbSettings };
