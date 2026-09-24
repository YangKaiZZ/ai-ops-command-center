// Brings an existing database up to date with schema.sql. Every step checks
// first, so it is safe to run again.
//
// Usage:  npm run migrate
const path = require('path');
process.chdir(path.join(__dirname, '..')); // so dotenv finds the backend .env

const pool = require('../src/config/db');
const { encryptSecret, decryptSecret, isEncrypted } = require('../src/config/secrets');

// Encrypts any secret column value that is still plain text. Each value is
// decrypted again before it's written, so a bad key can't lose a token.
async function encryptColumn(table, column) {
  const [rows] = await pool.query(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`);
  let changed = 0;
  for (const row of rows) {
    if (isEncrypted(row.value)) continue;
    const encrypted = encryptSecret(row.value);
    if (decryptSecret(encrypted) !== row.value) throw new Error(`${table}.${column} #${row.id}: round-trip check failed`);
    await pool.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [encrypted, row.id]);
    changed++;
  }
  return changed ? `encrypted ${changed} value(s)` : null;
}

async function columnExists(table, column) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return rows.length > 0;
}

async function addColumn(table, column, definition) {
  if (await columnExists(table, column)) return null;
  await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return 'added';
}

const STEPS = [
  ['encrypt sellers.shopify_access_token', () => encryptColumn('sellers', 'shopify_access_token')],
  ['sellers.slack_webhook_url', () => addColumn('sellers', 'slack_webhook_url', 'TEXT NULL AFTER shopify_access_token')],
];

async function main() {
  for (const [name, run] of STEPS) {
    const result = await run();
    console.log(`  ${result ? 'DONE' : 'ok  '}  ${name}${result ? ` - ${result}` : ''}`);
  }
}

main()
  .then(() => console.log('Database is up to date.'))
  .catch((err) => {
    console.error(`\nMigration failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
