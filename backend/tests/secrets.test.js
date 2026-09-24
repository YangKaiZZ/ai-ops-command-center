const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Fixed test secrets, set before the module loads (dotenv never overrides them).
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { encryptSecret, decryptSecret, isEncrypted } = require('../src/config/secrets');

test('encrypts and decrypts a secret', () => {
  const stored = encryptSecret('shpat_example');
  assert.ok(isEncrypted(stored));
  assert.ok(!stored.includes('shpat_example'));
  assert.equal(decryptSecret(stored), 'shpat_example');
});

test('same input encrypts differently each time (random IV)', () => {
  assert.notEqual(encryptSecret('x'), encryptSecret('x'));
});

test('empty values stay empty', () => {
  assert.equal(encryptSecret(''), null);
  assert.equal(encryptSecret(null), null);
  assert.equal(decryptSecret(null), null);
});

test('plain-text values from before encryption are passed through', () => {
  assert.equal(decryptSecret('shpat_legacy'), 'shpat_legacy');
});

test('a tampered value fails instead of decrypting to garbage', () => {
  const stored = encryptSecret('shpat_example');
  const parts = stored.split(':');
  const data = Buffer.from(parts[4], 'base64');
  data[0] ^= 1;
  parts[4] = data.toString('base64');
  assert.throws(() => decryptSecret(parts.join(':')));
});

// Loads the module in a child process with a controlled environment.
function loadWith(env) {
  const script = `require(${JSON.stringify(path.join(__dirname, '../src/config/secrets'))})`;
  try {
    execFileSync(process.execPath, ['-e', script], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      cwd: __dirname, // no .env here, so only `env` counts
      stdio: 'pipe',
    });
    return null;
  } catch (err) {
    return err.stderr.toString();
  }
}

test('refuses to start without a real JWT_SECRET', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  assert.match(loadWith({ ENCRYPTION_KEY: key }), /JWT_SECRET must be set/);
  assert.match(loadWith({ ENCRYPTION_KEY: key, JWT_SECRET: 'dev-secret-change-this' }), /JWT_SECRET must be set/);
  assert.match(loadWith({ ENCRYPTION_KEY: key, JWT_SECRET: 'short' }), /JWT_SECRET must be set/);
});

test('refuses to start without a 32-byte ENCRYPTION_KEY', () => {
  const jwtSecret = 'test-jwt-secret-0123456789abcdef';
  assert.match(loadWith({ JWT_SECRET: jwtSecret }), /ENCRYPTION_KEY must be set/);
  assert.match(loadWith({ JWT_SECRET: jwtSecret, ENCRYPTION_KEY: 'too-short' }), /ENCRYPTION_KEY must be set/);
  assert.equal(loadWith({ JWT_SECRET: jwtSecret, ENCRYPTION_KEY: 'ab'.repeat(32) }), null); // hex works too
});
