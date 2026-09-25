// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stockTone,
  stockPercent,
  parseReasoning,
  actionInfo,
  shopParam,
  formatPace,
  formatDaysLeft,
  forecastPhrases,
  roughNote,
  historySummary,
} from '../src/lib/format.ts';

test('stock bar color: red only when nothing is left, amber when low', () => {
  assert.equal(stockTone(0, 5), 'critical'); // out of stock -> red
  assert.equal(stockTone(-2, 5), 'critical'); // oversold -> red
  assert.equal(stockTone(1, 5), 'warning'); // some left -> amber
  assert.equal(stockTone(5, 5), 'warning'); // exactly at threshold -> amber
  assert.equal(stockTone(6, 5), 'good');
});

test('stock bar fill is stock as a share of the threshold, clamped', () => {
  assert.equal(stockPercent(0, 5), 0);
  assert.equal(stockPercent(3, 5), 60);
  assert.equal(stockPercent(9, 5), 100);
  assert.equal(stockPercent(-1, 5), 0);
  assert.equal(stockPercent(1, 0), 100); // threshold 0 doesn't divide by zero
});

test('reasoning: verdict dropped from headline, bullets grouped', () => {
  const r = parseReasoning('HOLD — #1002 cannot ship.\n\n- snowboard: 0 on hand\n• paid\nPlain note');
  assert.equal(r.headline, '#1002 cannot ship.');
  assert.deepEqual(r.blocks, [
    { type: 'bullets', items: ['snowboard: 0 on hand', 'paid'] },
    { type: 'text', text: 'Plain note' },
  ]);
});

test('verdict badges', () => {
  assert.equal(actionInfo('fulfill').label, 'Fulfill');
  assert.equal(actionInfo('hold').tone, 'warning');
  assert.equal(actionInfo('skipped').label, 'Skipped');
  assert.equal(actionInfo('something-new').label, 'Unclear');
});

test('reasoning: a skipped run reads as its reason, not "SKIPPED"', () => {
  const r = parseReasoning('SKIPPED - daily limit reached\nThis account has used its 50 agent checks.');
  assert.equal(r.headline, 'daily limit reached');
  assert.deepEqual(r.blocks, [{ type: 'text', text: 'This account has used its 50 agent checks.' }]);
});

test('install link shop: only exact *.myshopify.com addresses are passed on', () => {
  assert.equal(shopParam('My-Store.myshopify.com'), 'my-store.myshopify.com');
  assert.equal(shopParam(' my-store.myshopify.com '), 'my-store.myshopify.com');
  assert.equal(shopParam(null), '');
  assert.equal(shopParam('my-store'), ''); // Shopify always sends the full host
  assert.equal(shopParam('my-store.myshopify.com.attacker.example'), '');
  assert.equal(shopParam('https://my-store.myshopify.com'), '');
  assert.equal(shopParam('-bad.myshopify.com'), '');
});

test('sales pace and days left read the way a person says them', () => {
  assert.equal(formatPace(0), '0');
  assert.equal(formatPace(0.04), 'under 0.1');
  assert.equal(formatPace(0.4), 'about 0.4');
  assert.equal(formatPace(1.33), 'about 1.3');
  assert.equal(formatPace(12.6), 'about 13');
  assert.equal(formatDaysLeft(0.3), 'under a day');
  assert.equal(formatDaysLeft(1.2), 'about 1 day');
  assert.equal(formatDaysLeft(7.5), 'about 8 days');
});

test('the forecast line under a stock item', () => {
  const date = (iso) => `on ${iso.slice(0, 10)}`;
  const selling = { units_sold: 40, per_day: 1.33, days_left: 7.5, runs_out_at: '2026-10-03T12:00:00.000Z' };
  assert.deepEqual(forecastPhrases(selling, 30, date), ['Sells about 1.3 a day', 'runs out in about 8 days (on 2026-10-03)']);
  // Out of stock: the badge says so, so no run-out phrase.
  assert.deepEqual(forecastPhrases({ ...selling, days_left: 0, runs_out_at: null }, 30, date), ['Sells about 1.3 a day']);
  assert.deepEqual(forecastPhrases({ units_sold: 0, per_day: 0, days_left: null, runs_out_at: null }, 30, date), ['No sales in the last 30 days']);
  assert.deepEqual(forecastPhrases({ units_sold: 0, per_day: 0, days_left: 0, runs_out_at: null }, 1, date), ['No sales in the last 1 day']);
});

test('a rough forecast says why', () => {
  assert.equal(roughNote({ confidence: 'low', units_sold: 12, orders: 2 }), 'rough estimate: 2 orders');
  assert.equal(roughNote({ confidence: 'low', units_sold: 1, orders: 1 }), 'rough estimate: 1 order');
  assert.equal(roughNote({ confidence: 'low', units_sold: 30, orders: 9 }), 'rough estimate: under a week of orders');
  assert.equal(roughNote({ confidence: 'normal', units_sold: 30, orders: 9 }), null);
  assert.equal(roughNote({ confidence: 'low', units_sold: 0, orders: 0 }), null); // not selling: nothing to doubt
});

test('what the forecasts are based on', () => {
  const date = (iso) => iso.slice(0, 10);
  const history = { from: '2026-08-27T12:00:00.000Z', days: 30, orders: 12, orders_missing_items: 0 };
  assert.equal(historySummary(history, date), 'Forecasts are based on 30 days of orders: 12 orders since 2026-08-27.');
  assert.equal(
    historySummary({ ...history, from: '2026-09-21T12:00:00.000Z', days: 4.3, orders: 1 }, date),
    "Forecasts are based on 4 days of orders: 1 order since 2026-09-21. They're rough until there's at least a week of orders."
  );
  assert.match(historySummary({ ...history, days: 0.2 }, date), /^Forecasts are based on less than a day of orders/);
  assert.match(historySummary({ ...history, orders_missing_items: 1 }, date), /1 order from then doesn't have its items yet, so its sales aren't counted\.$/);
  assert.match(historySummary({ ...history, orders_missing_items: 3 }, date), /3 orders from then don't have their items yet, so their sales aren't counted\.$/);
  assert.equal(historySummary({ from: null, days: 0, orders: 0, orders_missing_items: 0 }, date), "No orders yet, so there's nothing to forecast from.");
});
