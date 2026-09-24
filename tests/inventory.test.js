const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { parseThreshold } = require('../src/controllers/inventoryController');

test('thresholds are whole numbers from 0 up', () => {
  assert.equal(parseThreshold(0), 0);
  assert.equal(parseThreshold(25), 25);
  assert.equal(parseThreshold('7'), 7); // from a form field
  for (const bad of [-1, 2.5, '2.5', '', ' ', 'ten', null, undefined, true, [], 1e7]) {
    assert.equal(parseThreshold(bad), null, JSON.stringify(bad));
  }
});
