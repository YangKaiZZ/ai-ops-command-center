// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourLabel, timeZoneOptions, browserTimeZone, LATE_AFTER_HOURS } from '../src/lib/reports.ts';

test('hours read as a 24-hour clock', () => {
  assert.equal(hourLabel(0), '00:00');
  assert.equal(hourLabel(8), '08:00');
  assert.equal(hourLabel(23), '23:00');
});

test('time zone choices always include UTC and the saved one, sorted, once each', () => {
  assert.deepEqual(timeZoneOptions('Asia/Manila', ['Europe/London', 'Asia/Manila']), ['Asia/Manila', 'Europe/London', 'UTC']);
  assert.deepEqual(timeZoneOptions('Pacific/Auckland', []), ['Pacific/Auckland', 'UTC']); // a browser that can't list them
  assert.ok(timeZoneOptions('UTC').length > 100); // Node knows them all
});

test('the default time zone is the browser\'s', () => {
  assert.equal(browserTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(LATE_AFTER_HOURS, [12, 24, 48, 72]);
});
