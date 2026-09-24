const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { isApiKey, hashApiKey, generateApiKey } = require('../src/models/apiKeyModel');

test('generated keys are prefixed, URL-safe and unique', () => {
  const a = generateApiKey();
  const b = generateApiKey();
  assert.match(a, /^aiops_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
});

test('API keys are told apart from sign-in JWTs by prefix', () => {
  assert.ok(isApiKey(generateApiKey()));
  assert.equal(isApiKey('eyJhbGciOiJIUzI1NiJ9.e30.sig'), false);
  assert.equal(isApiKey(undefined), false);
});

test('only a stable SHA-256 hash is stored', () => {
  const key = generateApiKey();
  assert.equal(hashApiKey(key), hashApiKey(key));
  assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
  assert.ok(!hashApiKey(key).includes(key));
});
