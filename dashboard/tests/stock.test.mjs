// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perDayText, reorderCsv, stockCounts } from '../src/lib/stock.ts';
import { daysLeftPercent, fulfillmentBadge, paymentBadge, stockStatus } from '../src/lib/format.ts';
import { percentChange, readPeriod } from '../src/lib/overview.ts';

const forecast = (over) => ({
  id: 1, item_name: 'Mug', stock_quantity: 4, units_sold: 20, orders: 10, per_day: 2.06,
  days_left: 2, runs_out_at: '2026-09-30T10:00:00.000Z', reorder_quantity: 58, confidence: 'normal', ...over,
});

test('an item status: out of stock, then running out soon, then low, then OK', () => {
  assert.deepEqual(stockStatus(0, 5, null), { label: 'Out of stock', tone: 'critical' });
  assert.deepEqual(stockStatus(-2, 5, 3), { label: 'Out of stock', tone: 'critical' });
  assert.deepEqual(stockStatus(40, 5, 6.5), { label: 'Out soon', tone: 'serious' }); // above its level, but selling fast
  assert.deepEqual(stockStatus(4, 5, null), { label: 'Low', tone: 'warning' }); // not selling, but at its level
  assert.deepEqual(stockStatus(4, 5, 12), { label: 'Low', tone: 'warning' });
  assert.deepEqual(stockStatus(40, 5, 20), { label: 'OK', tone: 'good' });
  assert.deepEqual(stockStatus(40, 5, 8, 7), { label: 'OK', tone: 'good' });
});

test('the days-left bar fills against the days a reorder covers', () => {
  assert.equal(daysLeftPercent(null, 30), null);
  assert.equal(daysLeftPercent(15, 30), 50);
  assert.equal(daysLeftPercent(90, 30), 100);
  assert.equal(daysLeftPercent(0, 30), 0);
  assert.equal(daysLeftPercent(3, 0), 100); // no divide by zero
});

test('shipping and payment statuses as pills', () => {
  assert.deepEqual(fulfillmentBadge(null), { label: 'Unfulfilled', tone: 'warning' });
  assert.deepEqual(fulfillmentBadge('fulfilled'), { label: 'Fulfilled', tone: 'good' });
  assert.deepEqual(fulfillmentBadge('partial'), { label: 'Partly shipped', tone: 'warning' });
  assert.deepEqual(fulfillmentBadge('on_hold'), { label: 'On hold', tone: 'neutral' }); // one Shopify adds later
  assert.deepEqual(paymentBadge('paid'), { label: 'Paid', tone: 'neutral' });
  assert.deepEqual(paymentBadge('pending'), { label: 'Pending', tone: 'warning' });
  assert.deepEqual(paymentBadge('partially_refunded'), { label: 'Partly refunded', tone: 'neutral' });
  assert.deepEqual(paymentBadge(null), { label: 'Unknown', tone: 'neutral' });
});

test('the change as a percent of the period before', () => {
  assert.equal(percentChange(12, 10), '+20%');
  assert.equal(percentChange(5, 10), '−50%');
  assert.equal(percentChange(10, 10), null);
  assert.equal(percentChange(4, 0), null); // nothing before to compare with
  assert.equal(percentChange(1000.2, 1000), null); // rounds to 0%
});

test('the Overview period comes from ?days= and falls back to 7', () => {
  assert.equal(readPeriod('14'), 14);
  assert.equal(readPeriod('30'), 30);
  assert.equal(readPeriod(null), 7);
  assert.equal(readPeriod('31'), 7);
  assert.equal(readPeriod('abc'), 7);
});

test('units a day, short for a table', () => {
  assert.equal(perDayText(0), '0');
  assert.equal(perDayText(0.04), '<0.1');
  assert.equal(perDayText(2.06), '2.1');
  assert.equal(perDayText(12.6), '13');
});

test('the Stock page counts', () => {
  const inventory = [
    { id: 1, stock_quantity: 0 },
    { id: 2, stock_quantity: 4 },
    { id: 3, stock_quantity: 50 },
  ];
  const forecasts = [
    forecast({ id: 1, stock_quantity: 0, days_left: 0, reorder_quantity: 12 }),
    forecast({ id: 2, days_left: 2 }),
    forecast({ id: 3, days_left: null, reorder_quantity: 0 }),
  ];
  assert.deepEqual(stockCounts(inventory, forecasts), { tracked: 3, outOfStock: 1, runningOut: 1, toReorder: 2 });
  assert.deepEqual(stockCounts(inventory, null), { tracked: 3, outOfStock: 1, runningOut: null, toReorder: null });
});

test('the reorder list as CSV: only items to reorder, quoted where needed, no formulas', () => {
  const csv = reorderCsv(
    [
      forecast({ item_name: 'Candle, small' }),
      forecast({ item_name: 'Plenty', reorder_quantity: 0 }),
      forecast({ item_name: '=HYPERLINK("x")', days_left: null, runs_out_at: null, per_day: 0 }),
    ],
    30,
    (iso) => `day of ${iso.slice(0, 10)}` // the page passes the seller's own calendar day
  );
  assert.equal(
    csv,
    'Item,In stock,Sells per day,Days left,Runs out,Reorder (to last 30 days)\r\n' +
      '"Candle, small",4,2.1,2,day of 2026-09-30,58\r\n' +
      '"\'=HYPERLINK(""x"")",4,0,,,58\r\n'
  );
});
