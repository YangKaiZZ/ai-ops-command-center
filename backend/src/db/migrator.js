const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { dbSettings } = require('../config/dbSettings');

// Versioned database migrations. Each file in migrations/ (NNN_name.sql, or
// .js exporting up(db)) runs once per database, in number order, and is
// recorded in schema_migrations with a checksum, so a migration edited after
// it ran is caught instead of silently drifting. A named MySQL lock stops two
// processes (say, two backends starting together) from migrating at once.
//
// Forward-only: MySQL can't roll back schema changes (each one commits by
// itself), so undoing means a new migration, or restoring a backup.

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');
const FILE_PATTERN = /^(\d+)_([a-z0-9_]+)\.(sql|js)$/;

const TRACKING_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(255) PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  duration_ms INT NOT NULL DEFAULT 0
)`;

// A file's checksum, ignoring Windows line endings: a Windows checkout of an
// unchanged file mustn't look edited.
function checksum(text) {
  return crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

// The migrations in `dir`, oldest first. Other kinds of files are ignored.
function listMigrations(dir = MIGRATIONS_DIR) {
  const byNumber = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(sql|js)$/.test(file)) continue;
    const match = file.match(FILE_PATTERN);
    if (!match) throw new Error(`${file}: name migrations like 002_add_something.sql`);
    const number = Number(match[1]);
    if (byNumber.has(number)) throw new Error(`${byNumber.get(number).file} and ${file} have the same number`);
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    byNumber.set(number, {
      version: file.replace(/\.(sql|js)$/, ''),
      number,
      file,
      kind: match[3],
      path: path.join(dir, file),
      text,
      checksum: checksum(text),
    });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// Each file against what ran here: applied, pending or changed; plus
// migrations that ran here but whose file is gone (missing).
function compare(migrations, appliedRows) {
  const applied = new Map(appliedRows.map((row) => [row.version, row]));
  const rows = migrations.map((m) => {
    const row = applied.get(m.version);
    const state = !row ? 'pending' : row.checksum === m.checksum ? 'applied' : 'changed';
    return { ...m, state, appliedAt: row?.applied_at ?? null };
  });
  const known = new Set(migrations.map((m) => m.version));
  const missing = appliedRows.filter((row) => !known.has(row.version)).map((row) => ({ version: row.version, appliedAt: row.applied_at }));
  return { rows, missing };
}

// The next file for a new migration, e.g. 004_add_order_line_items.sql.
function createMigration(name, dir = MIGRATIONS_DIR) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('give the migration a name, e.g. npm run migrate:new -- add_order_line_items');
  const next = Math.max(0, ...listMigrations(dir).map((m) => m.number)) + 1;
  const file = `${String(next).padStart(3, '0')}_${slug}.sql`;
  fs.writeFileSync(
    path.join(dir, file),
    `-- ${slug.replace(/_/g, ' ')}\n-- Runs once per database, after every lower-numbered migration. Once it has\n-- run anywhere, don't edit it: add another migration instead.\n\n`,
    { flag: 'wx' }
  );
  return file;
}

async function connect(settings, { create }) {
  const { database, ...server } = settings;
  if (!/^\w+$/.test(database)) throw new Error(`DB_NAME "${database}" should only have letters, numbers and _`);
  const conn = await mysql.createConnection({ ...server, multipleStatements: true });
  try {
    if (create) await conn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
    await conn.query(`USE \`${database}\``);
  } catch (err) {
    await conn.end();
    throw err;
  }
  return conn;
}

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return rows.length > 0;
}

async function appliedRows(conn) {
  if (!(await tableExists(conn, 'schema_migrations'))) return [];
  const [rows] = await conn.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version');
  return rows;
}

async function runMigration(conn, migration) {
  if (migration.kind === 'sql') {
    await conn.query(migration.text);
    return;
  }
  const mod = require(migration.path);
  if (typeof mod.up !== 'function') throw new Error('a .js migration must export an up(db) function');
  await mod.up(conn);
}

// A database from before versioned migrations has the tables but nothing in
// schema_migrations: bring it up to 001 with the old checks, then record 001.
async function adoptLegacyDatabase(conn, migrations, log) {
  const baseline = migrations.find((m) => m.number === 1);
  if (!baseline) throw new Error('this database predates migrations, but there is no 001 migration to record it as');
  log(`  This database was set up before versioned migrations; bringing it up to ${baseline.file}:`);
  const { upgradeLegacyDatabase } = require('./legacyUpgrade');
  await upgradeLegacyDatabase(conn, (line) => log(`  ${line}`));
  await conn.query(TRACKING_DDL);
  await conn.query('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [baseline.version, baseline.checksum]);
  log(`  DONE  recorded ${baseline.file} as applied`);
}

// Applies every pending migration. Refuses to run if an applied migration's
// file changed since. Resolves to the versions it applied.
async function migrate({ dir = MIGRATIONS_DIR, settings = dbSettings(), log = console.log, lockTimeoutSeconds = 60 } = {}) {
  const migrations = listMigrations(dir);
  const conn = await connect(settings, { create: true });
  const lock = `migrate:${settings.database}`;
  try {
    const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [lock, lockTimeoutSeconds]);
    if (got !== 1) throw new Error(`another migration is running on ${settings.database} (waited ${lockTimeoutSeconds}s)`);
    try {
      if ((await appliedRows(conn)).length === 0 && (await tableExists(conn, 'sellers'))) {
        await adoptLegacyDatabase(conn, migrations, log);
      }
      await conn.query(TRACKING_DDL);

      const { rows, missing } = compare(migrations, await appliedRows(conn));
      const changed = rows.filter((r) => r.state === 'changed');
      if (changed.length) {
        throw new Error(
          `${changed.map((r) => r.file).join(', ')} changed after running here. Put the old text back and make the change in a new migration.`
        );
      }
      for (const m of missing) log(`  note: ${m.version} ran here but its file is gone`);

      const newestApplied = Math.max(0, ...rows.filter((r) => r.state === 'applied').map((r) => r.number));
      const pending = rows.filter((r) => r.state === 'pending');
      for (const m of pending) {
        if (m.number < newestApplied) log(`  note: ${m.file} is older than migrations already run here; running it now`);
        const started = Date.now();
        try {
          await runMigration(conn, m);
        } catch (err) {
          throw new Error(`${m.file} failed: ${err.message}\nMySQL can't undo schema changes, so check what it already changed before running again.`);
        }
        const ms = Date.now() - started;
        await conn.query('INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES (?, ?, ?)', [m.version, m.checksum, ms]);
        log(`  DONE  ${m.file} (${ms} ms)`);
      }
      return pending.map((m) => m.version);
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?)', [lock]).catch(() => {});
    }
  } finally {
    await conn.end();
  }
}

// What has run on this database and what's pending, without changing anything.
async function status({ dir = MIGRATIONS_DIR, settings = dbSettings() } = {}) {
  const migrations = listMigrations(dir);
  let conn;
  try {
    conn = await connect(settings, { create: false });
  } catch (err) {
    if (err.code === 'ER_BAD_DB_ERROR') return { ...compare(migrations, []), databaseExists: false, legacy: false };
    throw err;
  }
  try {
    const applied = await appliedRows(conn);
    const legacy = applied.length === 0 && (await tableExists(conn, 'sellers'));
    return { ...compare(migrations, applied), databaseExists: true, legacy };
  } finally {
    await conn.end();
  }
}

module.exports = { migrate, status, createMigration, listMigrations, compare, checksum, MIGRATIONS_DIR };
