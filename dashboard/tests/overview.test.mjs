// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDay, periodStart, change, tileCount, tileMoney } from '../src/lib/overview.ts';

test('the period starts at local midnight 6 days ago, so "last 7 days" includes today', () => {
  const start = periodStart(new Date(2026, 8, 26, 15, 30)); // Sep 26, 15:30 local
  assert.equal(start.getTime(), new Date(2026, 8, 20, 0, 0, 0, 0).getTime());
  assert.equal(localDay(start), '2026-09-20');
  assert.equal(localDay(periodStart(new Date(2026, 2, 3, 0, 5))), '2026-02-25'); // across a month end
  assert.equal(localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('the change against the period before', () => {
  assert.deepEqual(change(12, 9), { direction: 'up', text: '+3' });
  assert.deepEqual(change(4, 7), { direction: 'down', text: '−3' });
  assert.deepEqual(change(5, 5), { direction: 'same', text: 'no change' });
  assert.deepEqual(change(170.5, 50, (n) => n.toFixed(2)), { direction: 'up', text: '+120.50' });
  assert.deepEqual(change(0.1 + 0.2, 0.3), { direction: 'same', text: 'no change' }); // float noise isn't a change
});

test('tile numbers stay short', () => {
  assert.equal(tileCount(0), '0');
  assert.equal(tileCount(1284), (1284).toLocaleString());
  assert.match(tileCount(12_940), /^12\.9\s?K$/);
  assert.equal(tileMoney(170.5), (170.5).toLocaleString(undefined, { minimumFractionDigits: 2 }));
  assert.match(tileMoney(4_200_000), /^4\.2\s?M$/);
});
