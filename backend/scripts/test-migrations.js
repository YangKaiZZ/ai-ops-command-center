// Runs the migrator against two throwaway databases on the configured MySQL
// server (created here and dropped at the end; the app's own database isn't
// touched):
//   1. a fresh database: 001 creates every table and is recorded; running again does nothing
//   2. new .sql and .js migrations run once, in order; an edited one stops the next run
//   3. a database from before migrations is adopted: the old checks restore a
//      missing table and column and encrypt a plain-text token, then 001 is recorded
//   4. while another connection holds the migration lock, a run waits and gives up
//
// Usage:  npm run test:migrations
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const fs = require('fs');
const os = require('os');
const mysql = require('mysql2/promise');
const { dbSettings } = require('../src/config/dbSettings');
const { migrate, status, listMigrations, MIGRATIONS_DIR } = require('../src/db/migrator');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};
const quiet = () => {};

async function main() {
  const base = dbSettings();
  const names = { fresh: `ai_ops_migtest_${process.pid}_fresh`, legacy: `ai_ops_migtest_${process.pid}_legacy` };
  const settings = (name) => ({ ...base, database: name });
  const { database: _appDatabase, ...server } = base;
  const admin = await mysql.createConnection({ ...server, multipleStatements: true });
  const tablesIn = async (db) =>
    (await admin.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY 1', [db]))[0].map((r) => r.t);
  const columnIn = async (db, table, column) =>
    (await admin.query('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?', [db, table, column]))[0].length === 1;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));

  try {
    console.log('\n1. A fresh database');
    let applied = await migrate({ settings: settings(names.fresh), log: quiet });
    const shipped = listMigrations(MIGRATIONS_DIR).map((m) => m.version);
    check(applied.join() === shipped.join() && applied[0] === '001_initial_schema', 'creates the database and applies every shipped migration', applied.join(', '));
    const tables = await tablesIn(names.fresh);
    const expected = ['agent_runs', 'api_keys', 'channel_links', 'customer_messages', 'decisions', 'inventory_items', 'jobs', 'oauth_states', 'orders', 'password_resets', 'privacy_requests', 'rate_limit_events', 'schema_migrations', 'sellers', 'webhook_deliveries'];
    check(expected.every((t) => tables.includes(t)), 'every table exists', tables.join(', '));
    applied = await migrate({ settings: settings(names.fresh), log: quiet });
    check(applied.length === 0, 'running again does nothing');

    console.log('\n2. New and edited migrations');
    for (const m of listMigrations(MIGRATIONS_DIR)) fs.copyFileSync(m.path, path.join(tmp, m.file));
    fs.writeFileSync(path.join(tmp, '900_add_test_flag.sql'), 'ALTER TABLE sellers ADD COLUMN test_flag TINYINT NULL;\n');
    fs.writeFileSync(
      path.join(tmp, '901_fill_test_flag.js'),
      "module.exports = { up: async (db) => { await db.query('UPDATE sellers SET test_flag = 1'); await db.query('CREATE TABLE made_by_js (id INT)'); } };\n"
    );
    applied = await migrate({ dir: tmp, settings: settings(names.fresh), log: quiet });
    check(applied.join(',') === '900_add_test_flag,901_fill_test_flag', 'the new .sql and .js migrations run, in order', applied.join(', '));
    check((await columnIn(names.fresh, 'sellers', 'test_flag')) && (await tablesIn(names.fresh)).includes('made_by_js'), 'their changes are there');
    check((await migrate({ dir: tmp, settings: settings(names.fresh), log: quiet })).length === 0, 'and they run only once');
    fs.appendFileSync(path.join(tmp, '900_add_test_flag.sql'), '-- edited afterwards\n');
    let error = null;
    try {
      await migrate({ dir: tmp, settings: settings(names.fresh), log: quiet });
    } catch (err) {
      error = err;
    }
    check(/900_add_test_flag\.sql changed after running/.test(error?.message), 'an edited migration stops the run, naming the file', error?.message.split('\n')[0]);
    const { rows } = await status({ dir: tmp, settings: settings(names.fresh) });
    check(rows.find((r) => r.version === '900_add_test_flag')?.state === 'changed', 'status shows it as changed');
    const crlf = fs.readFileSync(path.join(tmp, '901_fill_test_flag.js'), 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(tmp, '901_fill_test_flag.js'), crlf);
    const again = await status({ dir: tmp, settings: settings(names.fresh) });
    check(again.rows.find((r) => r.version === '901_fill_test_flag')?.state === 'applied', 'Windows line endings alone don\'t count as an edit');

    console.log('\n3. A database from before migrations');
    await admin.query(`CREATE DATABASE \`${names.legacy}\``);
    await admin.query(`USE \`${names.legacy}\``);
    await admin.query(listMigrations(MIGRATIONS_DIR)[0].text); // as the old schema.sql would have made it...
    await admin.query('DROP TABLE jobs; ALTER TABLE sellers DROP COLUMN telegram_chat_id'); // ...before later additions
    await admin.query("INSERT INTO sellers (business_name, email, password_hash, shopify_access_token) VALUES ('Legacy', 'legacy@example.test', 'x', 'shpat_plain_old_token')");
    const before = await status({ settings: settings(names.legacy) });
    check(before.legacy === true, 'status recognises it');
    const lines = [];
    applied = await migrate({ settings: settings(names.legacy), log: (line) => lines.push(line) });
    check(applied.join() === shipped.slice(1).join() && lines.some((l) => /recorded 001_initial_schema\.sql as applied/.test(l)), 'the first run adopts it and records 001', lines.filter((l) => /DONE/.test(l)).length + ' step(s) done');
    check((await tablesIn(names.legacy)).includes('jobs') && (await columnIn(names.legacy, 'sellers', 'telegram_chat_id')), 'the missing table and column are back');
    const [[seller]] = await admin.query('SELECT shopify_access_token AS t FROM sellers');
    const { decryptSecret, isEncrypted } = require('../src/config/secrets');
    check(isEncrypted(seller.t) && decryptSecret(seller.t) === 'shpat_plain_old_token', 'the plain-text token is now encrypted');
    check((await migrate({ settings: settings(names.legacy), log: quiet })).length === 0, 'running again does nothing');

    console.log('\n4. The lock');
    const holder = await mysql.createConnection(server);
    await holder.query('SELECT GET_LOCK(?, 0)', [`migrate:${names.fresh}`]);
    const started = Date.now();
    error = null;
    try {
      await migrate({ settings: settings(names.fresh), log: quiet, lockTimeoutSeconds: 1 });
    } catch (err) {
      error = err;
    }
    check(/another migration is running/.test(error?.message) && Date.now() - started >= 900, 'a run waits for the lock, then gives up', error?.message);
    await holder.end();
  } finally {
    for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\nDropped the test databases.');
  }
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.stack || err.message}`);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
  });
