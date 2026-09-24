const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { validateRegistration } = require('../src/controllers/authController');

const good = { business_name: '  Gloria Flowers ', email: ' Owner@Example.COM ', password: 'correct horse' };

test('cleans up a valid sign-up', () => {
  assert.deepEqual(validateRegistration(good), {
    businessName: 'Gloria Flowers',
    email: 'owner@example.com',
    password: 'correct horse',
  });
});

test('accepts ordinary addresses', () => {
  for (const email of ['sales@shop.store', 'first.last+tag@sub.example.co.uk', 'x@y.io']) {
    assert.equal(validateRegistration({ ...good, email }).email, email);
  }
  assert.match(validateRegistration({ ...good, email: 'two words@example.com' }).error, /valid email/);
  assert.match(validateRegistration({ ...good, email: 'user@nodot' }).error, /valid email/);
});

test('rejects missing or malformed fields with a message a person can act on', () => {
  assert.match(validateRegistration({ ...good, business_name: '   ' }).error, /business name/);
  assert.match(validateRegistration({ ...good, email: 'not-an-email' }).error, /valid email/);
  assert.match(validateRegistration({ ...good, password: 'short' }).error, /at least 8/);
  assert.match(validateRegistration({}).error, /business name/);
  assert.match(validateRegistration({ ...good, email: ['a@b.co'] }).error, /valid email/);
});
