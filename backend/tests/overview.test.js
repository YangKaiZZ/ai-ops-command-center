const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { parseOverviewQuery, countDecisions, runningOut } = require('../src/controllers/overviewController');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');

test('the period starts at ?from=, or 7 days ago', () => {
  assert.deepEqual(parseOverviewQuery({}, NOW), { fromMs: NOW - 7 * DAY });
  assert.deepEqual(parseOverviewQuery({ from: '2026-09-20T00:00:00+08:00' }, NOW), { fromMs: Date.parse('2026-09-19T16:00:00Z') });
  assert.deepEqual(parseOverviewQuery({ from: '2026-08-26T12:00:00Z' }, NOW), { fromMs: NOW - 31 * DAY }); // the furthest back
});

test('from must be a date-time, not in the future, at most 31 days back', () => {
  for (const from of ['2026-09-20', 'last week', '', '2026-09-26T12:00:01Z', '2026-08-26T11:59:59Z', '2026-13-01T00:00:00Z', ['2026-09-20T00:00:00Z']]) {
    assert.match(parseOverviewQuery({ from }, NOW).error, /from must be a date-time within the last 31 days/, JSON.stringify(from));
  }
});

test('decision counts have every verdict and a total', () => {
  assert.deepEqual(
    countDecisions([
      { action_taken: 'fulfill', n: 5 },
      { action_taken: 'hold', n: '2' },
      { action_taken: 'something-new', n: 1 },
    ]),
    { fulfill: 5, hold: 2, low_stock_alert: 0, unknown: 1, skipped: 0, total: 8 }
  );
  assert.deepEqual(countDecisions([]), { fulfill: 0, hold: 0, low_stock_alert: 0, unknown: 0, skipped: 0, total: 0 });
});

test('running out soon: still in stock, gone within 7 days, soonest first', () => {
  const item = (id, days_left) => ({ id, item_name: `Item ${id}`, stock_quantity: 5, per_day: 1, days_left, runs_out_at: null, reorder_quantity: 10, confidence: 'normal', units_sold: 30 });
  // The forecast already lists them soonest first.
  const soon = runningOut([item(1, 0), item(2, 0.5), item(3, 7), item(4, 7.1), item(5, null)]);
  assert.deepEqual(soon.map((i) => i.id), [2, 3]); // out of stock (0), later than a week and not selling are left out
  assert.ok(!('units_sold' in soon[0]));
});
