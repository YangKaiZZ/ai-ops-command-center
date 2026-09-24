const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { LIMITS, subjectKey, isLoopback, describeWait } = require('../src/services/rateLimit');

test('emails and addresses are stored as keyed hashes, not as themselves', () => {
  const key = subjectKey(LIMITS.loginFailuresPerAccount, 'owner@example.com');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes('owner'));
  assert.equal(key, subjectKey(LIMITS.loginFailuresPerAccount, ' Owner@Example.COM '), 'case and spaces make no difference');
  assert.notEqual(key, subjectKey(LIMITS.signupsPerIp, 'owner@example.com'), 'each limit has its own hashes');
});

test('only requests from this machine skip the address limits', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(ip), ip);
  for (const ip of ['203.0.113.7', '10.0.0.2', '172.18.0.5', undefined]) assert.ok(!isLoopback(ip), String(ip));
});

test('waits read as minutes, rounded up', () => {
  assert.equal(describeWait(5), 'about a minute');
  assert.equal(describeWait(60), 'about a minute');
  assert.equal(describeWait(61), 'about 2 minutes');
  assert.equal(describeWait(900), 'about 15 minutes');
});

test('the limits are the documented ones', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(LIMITS).map(([name, l]) => [name, [l.max, l.windowSeconds]])),
    { loginFailuresPerAccount: [10, 900], loginFailuresPerIp: [30, 900], signupsPerIp: [10, 3600] }
  );
});
