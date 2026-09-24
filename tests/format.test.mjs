// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockTone, stockPercent, parseReasoning, actionInfo } from '../src/lib/format.ts';

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
  assert.equal(actionInfo('something-new').label, 'Unclear');
});
