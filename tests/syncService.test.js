const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { crossedLowStock } = require('../src/services/syncService');
const { withLock } = require('../src/utils/lock');

test('an item crosses only when it goes from above its threshold to at/below it', () => {
  const prev = { stock_quantity: 8, low_stock_threshold: 5 };
  assert.equal(crossedLowStock(prev, 5), true);
  assert.equal(crossedLowStock(prev, 0), true);
  assert.equal(crossedLowStock(prev, 6), false);
  assert.equal(crossedLowStock({ stock_quantity: 4, low_stock_threshold: 5 }, 2), false); // already low: no repeat alert
  assert.equal(crossedLowStock(undefined, 0), false); // first time we see it
});

test('work for the same key runs one at a time, in order', async () => {
  const events = [];
  const job = (name, ms) => async () => {
    events.push(`${name} start`);
    await new Promise((r) => setTimeout(r, ms));
    events.push(`${name} end`);
    return name;
  };
  const results = await Promise.all([withLock('seller:1', job('a', 30)), withLock('seller:1', job('b', 1))]);
  assert.deepEqual(results, ['a', 'b']);
  assert.deepEqual(events, ['a start', 'a end', 'b start', 'b end']);
});

test('a failed job does not block the next one', async () => {
  const failed = withLock('seller:2', async () => {
    throw new Error('boom');
  });
  await assert.rejects(failed, /boom/);
  assert.equal(await withLock('seller:2', async () => 'next'), 'next');
});

test('different keys run independently', async () => {
  const events = [];
  const slow = withLock('seller:3', async () => {
    await new Promise((r) => setTimeout(r, 30));
    events.push('slow');
  });
  await withLock('seller:4', async () => events.push('fast'));
  await slow;
  assert.deepEqual(events, ['fast', 'slow']);
});
