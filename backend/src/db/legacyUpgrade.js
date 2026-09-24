// Before versioned migrations, `npm run migrate` was this list of steps, each
// checking first, that brought any older database up to the schema now in
// migrations/001_initial_schema.sql. The migrator runs it once on a database
// from those days (it has tables but no schema_migrations yet), then records
// 001 as applied. New changes go in new migration files, never here.
const { encryptSecret, decryptSecret, isEncrypted } = require('../config/secrets');

let db; // the connection upgradeLegacyDatabase() was given

// Encrypts any secret column value that is still plain text. Each value is
// decrypted again before it's written, so a bad key can't lose a token.
async function encryptColumn(table, column) {
  const [rows] = await db.query(`SELECT id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`);
  let changed = 0;
  for (const row of rows) {
    if (isEncrypted(row.value)) continue;
    const encrypted = encryptSecret(row.value);
    if (decryptSecret(encrypted) !== row.value) throw new Error(`${table}.${column} #${row.id}: round-trip check failed`);
    await db.query(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [encrypted, row.id]);
    changed++;
  }
  return changed ? `encrypted ${changed} value(s)` : null;
}

async function columnExists(table, column) {
  const [rows] = await db.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return rows.length > 0;
}

async function addColumn(table, column, definition) {
  if (await columnExists(table, column)) return null;
  await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return 'added';
}

async function addIndex(table, index, columns, { unique = false } = {}) {
  const [rows] = await db.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [table, index]
  );
  if (rows.length) return null;
  await db.query(`ALTER TABLE ${table} ADD ${unique ? 'UNIQUE ' : ''}INDEX ${index} (${columns})`);
  return 'added';
}

// A store can belong to one account. Checked before adding the unique index,
// so the migration explains the problem instead of failing on a duplicate.
async function uniqueShopDomains() {
  const [dupes] = await db.query(
    `SELECT shopify_shop_domain, GROUP_CONCAT(id) AS ids FROM sellers
     WHERE shopify_shop_domain IS NOT NULL GROUP BY shopify_shop_domain HAVING COUNT(*) > 1`
  );
  if (dupes.length) {
    const list = dupes.map((d) => `${d.shopify_shop_domain} (sellers ${d.ids})`).join(', ');
    throw new Error(`Several accounts share a store: ${list}. Clear shopify_shop_domain on all but one, then run again.`);
  }
  return addIndex('sellers', 'uniq_shop_domain', 'shopify_shop_domain', { unique: true });
}

async function createTable(table, ddl) {
  const [rows] = await db.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  if (rows.length) return null;
  await db.query(ddl);
  return 'created';
}

// Same definitions as migrations/001_initial_schema.sql.
const API_KEYS_DDL = `CREATE TABLE api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  FOREIGN KEY (seller_id) REFERENCES sellers(id),
  UNIQUE KEY uniq_key_hash (key_hash)
);`;

const OAUTH_STATES_DDL = `CREATE TABLE oauth_states (
  state CHAR(48) PRIMARY KEY,
  seller_id INT NOT NULL,
  shop VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE
);`;

const PRIVACY_REQUESTS_DDL = `CREATE TABLE privacy_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NULL,
  topic VARCHAR(50) NOT NULL,
  shop_domain VARCHAR(255),
  details JSON,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL,
  INDEX idx_seller_topic (seller_id, topic)
);`;

const CHANNEL_LINKS_DDL = `CREATE TABLE channel_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  channel VARCHAR(20) NOT NULL,
  target VARCHAR(255),
  code_hash CHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  INDEX idx_seller_channel (seller_id, channel),
  INDEX idx_code (code_hash)
);`;

const AGENT_RUNS_DDL = `CREATE TABLE agent_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  INDEX idx_seller_started (seller_id, started_at),
  INDEX idx_started (started_at)
);`;

const JOBS_DDL = `CREATE TABLE jobs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  seller_id INT NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_after TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at TIMESTAMP NULL,
  last_error TEXT,
  dedupe_key VARCHAR(191) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_dedupe (dedupe_key),
  INDEX idx_claim (status, run_after)
);`;

const WEBHOOK_DELIVERIES_DDL = `CREATE TABLE webhook_deliveries (
  webhook_id VARCHAR(255) PRIMARY KEY,
  topic VARCHAR(50) NOT NULL,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_received (received_at)
);`;

const STEPS = [
  ['encrypt sellers.shopify_access_token', () => encryptColumn('sellers', 'shopify_access_token')],
  ['sellers.slack_webhook_url', () => addColumn('sellers', 'slack_webhook_url', 'TEXT NULL AFTER shopify_access_token')],
  ['sellers.orders_synced_at', () => addColumn('sellers', 'orders_synced_at', 'TIMESTAMP NULL AFTER slack_webhook_url')],
  [
    'inventory_items.shopify_inventory_item_id',
    () => addColumn('inventory_items', 'shopify_inventory_item_id', 'VARCHAR(100) NULL AFTER shopify_variant_id'),
  ],
  [
    'index inventory_items(seller_id, shopify_inventory_item_id)',
    () => addIndex('inventory_items', 'idx_seller_inventory_item', 'seller_id, shopify_inventory_item_id'),
  ],
  ['api_keys table', () => createTable('api_keys', API_KEYS_DDL)],
  ['sellers.shopify_refresh_token', () => addColumn('sellers', 'shopify_refresh_token', 'TEXT NULL AFTER shopify_access_token')],
  [
    'sellers.shopify_token_expires_at',
    () => addColumn('sellers', 'shopify_token_expires_at', 'TIMESTAMP NULL AFTER shopify_refresh_token'),
  ],
  ['sellers.shopify_scopes', () => addColumn('sellers', 'shopify_scopes', 'VARCHAR(500) NULL AFTER shopify_token_expires_at')],
  ['unique sellers.shopify_shop_domain', uniqueShopDomains],
  ['oauth_states table', () => createTable('oauth_states', OAUTH_STATES_DDL)],
  ['privacy_requests table', () => createTable('privacy_requests', PRIVACY_REQUESTS_DDL)],
  [
    'sellers.default_low_stock_threshold',
    () => addColumn('sellers', 'default_low_stock_threshold', 'INT NOT NULL DEFAULT 5 AFTER orders_synced_at'),
  ],
  ['sellers.alert_email', () => addColumn('sellers', 'alert_email', 'VARCHAR(255) NULL AFTER slack_webhook_url')],
  ['sellers.telegram_chat_id', () => addColumn('sellers', 'telegram_chat_id', 'VARCHAR(64) NULL AFTER alert_email')],
  ['channel_links table', () => createTable('channel_links', CHANNEL_LINKS_DDL)],
  ['agent_runs table', () => createTable('agent_runs', AGENT_RUNS_DDL)],
  ['jobs table', () => createTable('jobs', JOBS_DDL)],
  ['webhook_deliveries table', () => createTable('webhook_deliveries', WEBHOOK_DELIVERIES_DDL)],
];

async function upgradeLegacyDatabase(connection, log = console.log) {
  db = connection;
  for (const [name, run] of STEPS) {
    const result = await run();
    log(`  ${result ? 'DONE' : 'ok  '}  ${name}${result ? ` - ${result}` : ''}`);
  }
}

module.exports = { upgradeLegacyDatabase };
