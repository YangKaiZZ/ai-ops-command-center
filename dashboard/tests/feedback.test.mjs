// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accuracyPercent, accuracyText, canRate, filterDecisions } from '../src/lib/feedback.ts';

test('accuracy: the share of rated decisions marked right', () => {
  assert.equal(accuracyText({ up: 12, down: 2 }), '12 of 14 rated right (86%)');
  assert.equal(accuracyText({ up: 1, down: 0 }), '1 of 1 rated right (100%)');
  assert.equal(accuracyText({ up: 0, down: 3 }), '0 of 3 rated right (0%)');
  assert.equal(accuracyText({ up: 0, down: 0 }), null); // nothing rated yet
});

test('accuracy never rounds to 100% with a wrong call, or to 0% with a right one', () => {
  assert.equal(accuracyPercent({ up: 299, down: 1 }), 99);
  assert.equal(accuracyPercent({ up: 1, down: 299 }), 1);
  assert.equal(accuracyPercent({ up: 2, down: 1 }), 67);
});

test('skipped runs cannot be rated', () => {
  assert.equal(canRate('skipped'), false);
  for (const action of ['fulfill', 'hold', 'low_stock_alert', 'unknown']) assert.equal(canRate(action), true);
});

test('filters: not rated yet, and marked wrong', () => {
  const decisions = [
    { id: 1, action_taken: 'fulfill', feedback: null },
    { id: 2, action_taken: 'hold', feedback: 'down' },
    { id: 3, action_taken: 'skipped', feedback: null },
    { id: 4, action_taken: 'fulfill', feedback: 'up' },
  ];
  const ids = (list) => list.map((d) => d.id);
  assert.deepEqual(ids(filterDecisions(decisions, 'all')), [1, 2, 3, 4]);
  assert.deepEqual(ids(filterDecisions(decisions, 'unrated')), [1]); // skipped left out
  assert.deepEqual(ids(filterDecisions(decisions, 'wrong')), [2]);
  // Rated since the filter was picked: stays in view.
  assert.deepEqual(ids(filterDecisions(decisions, 'unrated', new Set([4]))), [1, 4]);
  assert.deepEqual(ids(filterDecisions(decisions, 'wrong', new Set([4]))), [2, 4]);
});
