const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { forecastItem, historyWindow, parseForecastQuery, byUrgency } = require('../src/services/restockForecast');
const { describeTrigger } = require('../src/services/agentService');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');
const opts = (historyDays, coverDays = 30) => ({ historyDays, coverDays, nowMs: NOW });

test('pace, run-out date and reorder amount', () => {
  // 40 sold in 30 days, 10 left: ~1.33 a day, out in 7.5 days; 30 days' worth is 40, minus the 10 in stock.
  const f = forecastItem(10, { units: 40, orders: 12 }, opts(30));
  assert.equal(f.per_day, 1.33);
  assert.equal(f.days_left, 7.5);
  assert.equal(f.runs_out_at, new Date(NOW + 7.5 * DAY).toISOString());
  assert.equal(f.reorder_quantity, 30);
  assert.equal(f.confidence, 'normal');
  assert.equal(f.units_sold, 40);
  assert.equal(f.orders, 12);
});

test('reorder amounts round up, without float noise adding one', () => {
  assert.equal(forecastItem(0, { units: 4, orders: 4 }, opts(3)).reorder_quantity, 40); // 4/3 a day * 30 = 40, not 41
  assert.equal(forecastItem(5, { units: 7, orders: 5 }, opts(30)).reorder_quantity, 2); // 7 needed, 5 in stock
  assert.equal(forecastItem(3, { units: 1, orders: 1 }, opts(30, 45)).reorder_quantity, 0); // 1.5 needed, 3 in stock
});

test('enough stock for the whole cover period: nothing to reorder', () => {
  const f = forecastItem(100, { units: 30, orders: 10 }, opts(30));
  assert.equal(f.days_left, 100);
  assert.equal(f.reorder_quantity, 0);
});

test('out of stock: zero days left, no run-out date, oversold units added to the reorder', () => {
  const out = forecastItem(0, { units: 10, orders: 5 }, opts(10, 7));
  assert.equal(out.days_left, 0);
  assert.equal(out.runs_out_at, null);
  assert.equal(out.reorder_quantity, 7);
  const oversold = forecastItem(-2, { units: 10, orders: 5 }, opts(10, 7));
  assert.equal(oversold.reorder_quantity, 9);
  // Oversold but not selling lately: still reorder what's owed.
  assert.equal(forecastItem(-2, undefined, opts(30)).reorder_quantity, 2);
});

test('an item that isn\'t selling has no run-out date and nothing to reorder', () => {
  const f = forecastItem(12, undefined, opts(30));
  assert.deepEqual(
    { per_day: f.per_day, days_left: f.days_left, runs_out_at: f.runs_out_at, reorder_quantity: f.reorder_quantity, units_sold: f.units_sold },
    { per_day: 0, days_left: null, runs_out_at: null, reorder_quantity: 0, units_sold: 0 }
  );
});

test('few orders or a short history mean low confidence', () => {
  assert.equal(forecastItem(10, { units: 20, orders: 2 }, opts(30)).confidence, 'low');
  assert.equal(forecastItem(10, { units: 20, orders: 3 }, opts(30)).confidence, 'normal');
  assert.equal(forecastItem(10, { units: 20, orders: 10 }, opts(6.9)).confidence, 'low');
  assert.equal(forecastItem(10, { units: 20, orders: 10 }, opts(7)).confidence, 'normal');
});

test('a history under a day counts as a day, so one fresh order doesn\'t look like a rush', () => {
  assert.equal(forecastItem(10, { units: 2, orders: 1 }, opts(0.1)).per_day, 2);
});

test('the history is the lookback, or less when the first order is more recent', () => {
  assert.deepEqual(historyWindow(null, NOW, 30), { fromMs: null, days: 0 });
  assert.deepEqual(historyWindow(NOW - 400 * DAY, NOW, 30), { fromMs: NOW - 30 * DAY, days: 30 });
  assert.deepEqual(historyWindow(NOW - 4.5 * DAY, NOW, 30), { fromMs: NOW - 4.5 * DAY, days: 4.5 });
  assert.deepEqual(historyWindow(NOW + DAY, NOW, 30), { fromMs: NOW, days: 0 }); // clocks disagree
});

test('soonest to run out first, items not selling last', () => {
  const items = [
    { item_name: 'Idle', days_left: null, reorder_quantity: 0 },
    { item_name: 'Later', days_left: 20, reorder_quantity: 5 },
    { item_name: 'Out B', days_left: 0, reorder_quantity: 3 },
    { item_name: 'Out A', days_left: 0, reorder_quantity: 3 },
    { item_name: 'Soon', days_left: 2.5, reorder_quantity: 40 },
    { item_name: 'Out big', days_left: 0, reorder_quantity: 30 },
  ];
  assert.deepEqual(items.sort(byUrgency).map((i) => i.item_name), ['Out big', 'Out A', 'Out B', 'Soon', 'Later', 'Idle']);
});

test('query: days and cover_days are whole days in range, with defaults', () => {
  assert.deepEqual(parseForecastQuery({}), { lookbackDays: 30, coverDays: 30 });
  assert.deepEqual(parseForecastQuery({ days: '90', cover_days: '7' }), { lookbackDays: 90, coverDays: 7 });
  for (const days of ['0', '91', '-1', '1.5', 'abc', '', ' 30']) {
    assert.match(parseForecastQuery({ days }).error, /days must be a whole number of days from 1 to 90/, days);
  }
  assert.match(parseForecastQuery({ cover_days: '181' }).error, /cover_days must be a whole number of days from 1 to 180/);
  assert.match(parseForecastQuery({ days: ['30', '60'] }).error, /days/); // ?days=30&days=60
});

test('a low-stock prompt carries the forecast when there is one', () => {
  const trigger = { type: 'low_stock_crossed', items: [{ item_name: 'Mug', shopify_variant_id: '5001', current_stock: 4, low_stock_threshold: 5 }] };
  const forecast = {
    based_on: { days: 30, orders: 12 },
    cover_days: 30,
    items: [{ item_name: 'Mug', per_day: 1.33, days_left: 3, runs_out_on: '2026-09-29', reorder_quantity: 36, confidence: 'normal' }],
  };
  const withForecast = describeTrigger(trigger, null, forecast);
  assert.match(withForecast, /^An inventory sync just pushed these items/);
  assert.match(withForecast, /Restock forecast for these items, computed from the store's orders:/);
  assert.match(withForecast, /"reorder_quantity": 36/);
  assert.match(withForecast, /"based_on": \{\s*"days": 30,\s*"orders": 12/);
  assert.doesNotMatch(describeTrigger(trigger, null, null), /Restock forecast/);
  assert.doesNotMatch(describeTrigger(trigger, null), /Restock forecast/);
});
