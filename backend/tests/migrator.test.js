const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listMigrations, compare, checksum, createMigration, MIGRATIONS_DIR } = require('../src/db/migrator');

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('migrations run in number order, not name order', () => {
  const dir = tempDir({ '010_later.sql': 'SELECT 10;', '002_second.js': 'module.exports = { up() {} };', '001_first.sql': 'SELECT 1;', 'README.md': 'notes' });
  assert.deepEqual(listMigrations(dir).map((m) => m.version), ['001_first', '002_second', '010_later']);
  assert.deepEqual(listMigrations(dir).map((m) => m.kind), ['sql', 'js', 'sql']);
});

test('two files with one number, or a badly named file, are refused', () => {
  assert.throws(() => listMigrations(tempDir({ '001_a.sql': '', '001_b.sql': '' })), /same number/);
  assert.throws(() => listMigrations(tempDir({ 'add-things.sql': '' })), /name migrations like/);
});

test("a checksum doesn't change with Windows line endings, but does with content", () => {
  assert.equal(checksum('CREATE TABLE a (id INT);\r\nSELECT 1;\r\n'), checksum('CREATE TABLE a (id INT);\nSELECT 1;\n'));
  assert.notEqual(checksum('SELECT 1;'), checksum('SELECT 2;'));
});

test('each file is applied, pending or changed; a vanished file is reported', () => {
  const dir = tempDir({ '001_a.sql': 'SELECT 1;', '002_b.sql': 'SELECT 2;', '003_c.sql': 'SELECT 3;' });
  const migrations = listMigrations(dir);
  const { rows, missing } = compare(migrations, [
    { version: '001_a', checksum: checksum('SELECT 1;'), applied_at: new Date() },
    { version: '002_b', checksum: checksum('SELECT 2; -- edited'), applied_at: new Date() },
    { version: '000_old', checksum: 'x', applied_at: new Date() },
  ]);
  assert.deepEqual(rows.map((r) => [r.version, r.state]), [['001_a', 'applied'], ['002_b', 'changed'], ['003_c', 'pending']]);
  assert.deepEqual(missing.map((m) => m.version), ['000_old']);
});

test('a new migration gets the next number and a tidy name', () => {
  const dir = tempDir({ '001_a.sql': '', '007_b.sql': '' });
  assert.equal(createMigration('Add order line-items', dir), '008_add_order_line_items.sql');
  assert.match(fs.readFileSync(path.join(dir, '008_add_order_line_items.sql'), 'utf8'), /^-- add order line items/);
  assert.throws(() => createMigration('  !! ', dir), /give the migration a name/);
});

test('the real migrations folder starts with the initial schema', () => {
  const [first] = listMigrations(MIGRATIONS_DIR);
  assert.equal(first.version, '001_initial_schema');
  assert.doesNotMatch(first.text, /CREATE DATABASE|^USE /m); // the migrator chooses the database
  for (const table of ['sellers', 'orders', 'decisions', 'agent_runs', 'jobs', 'webhook_deliveries']) {
    assert.match(first.text, new RegExp(`CREATE TABLE ${table} \\(`), table);
  }
});
