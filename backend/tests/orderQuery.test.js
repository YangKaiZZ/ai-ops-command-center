const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { parseOrderQuery } = require('../src/controllers/ordersController');

test('no query: the first 50', () => {
  assert.deepEqual(parseOrderQuery({}), { limit: 50, offset: 0, where: [], params: [] });
});

test('limit and offset must be whole numbers in range', () => {
  assert.equal(parseOrderQuery({ limit: '200', offset: '400' }).limit, 200);
  for (const bad of [{ limit: '0' }, { limit: '201' }, { limit: '5.5' }, { limit: '-1' }, { limit: 'ten' }, { limit: ['5', '6'] }, { offset: '-3' }]) {
    assert.match(parseOrderQuery(bad).error, /must be a whole number/, JSON.stringify(bad));
  }
});

test('statuses must be Shopify values', () => {
  assert.deepEqual(parseOrderQuery({ status: 'unfulfilled', financial_status: 'paid' }).params, ['unfulfilled', 'paid']);
  assert.match(parseOrderQuery({ status: 'shipped' }).error, /status must be one of/);
  assert.match(parseOrderQuery({ financial_status: "paid' OR 1=1" }).error, /financial_status must be one of/);
});

test('dates cover whole UTC days; date-times are exact', () => {
  const day = parseOrderQuery({ from: '2026-09-01', to: '2026-09-01' });
  assert.deepEqual(day.params, [Date.UTC(2026, 8, 1) / 1000, Date.UTC(2026, 8, 1) / 1000 + 86399]);
  const exact = parseOrderQuery({ from: '2026-09-01T12:00:00Z' });
  assert.deepEqual(exact.params, [Date.UTC(2026, 8, 1, 12) / 1000]);
  for (const bad of ['yesterday', '2026-13-01', '2026-9-1', '1790000000']) {
    assert.match(parseOrderQuery({ from: bad }).error, /must be a date/, bad);
  }
  assert.match(parseOrderQuery({ from: '2026-09-02', to: '2026-09-01' }).error, /from must not be after to/);
});

test('an order number matches with or without #', () => {
  for (const number of ['1001', '#1001', ' #1001 ']) {
    assert.deepEqual(parseOrderQuery({ number }).params, ['#1001', '1001'], number);
  }
  assert.match(parseOrderQuery({ number: '#' }).error, /order number/);
});

test('the pending list takes paging only', () => {
  assert.deepEqual(parseOrderQuery({ status: 'bogus', limit: '5' }, { filters: false }), { limit: 5, offset: 0, where: [], params: [] });
});
