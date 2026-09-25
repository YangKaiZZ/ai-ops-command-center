// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'Asia/Kuala_Lumpur'; // UTC+8, no daylight saving: fixed expectations below
const { readFilters, hasFilters, filtersUrl, ordersApiQuery, NO_FILTERS } = await import('../src/lib/orderFilters.ts');

test('filters are read from the URL, ignoring anything unrecognised', () => {
  const f = readFilters(new URLSearchParams('q=%20Smith%20&status=fulfilled&payment=paid&from=2026-08-01&to=2026-08-31&needs_action=1&risk=flagged&page=2'));
  assert.deepEqual(f, { q: 'Smith', status: 'fulfilled', payment: 'paid', from: '2026-08-01', to: '2026-08-31', needsAction: true, flagged: true });
  const junk = readFilters(new URLSearchParams('status=shipped&payment=free&from=yesterday&to=2026-8-1&needs_action=true&risk=high'));
  assert.deepEqual(junk, NO_FILTERS);
  assert.equal(readFilters(new URLSearchParams(`q=${'x'.repeat(150)}`)).q.length, 100);
});

test('the URL keeps only what is set, and page only past the first', () => {
  assert.equal(filtersUrl(NO_FILTERS), '/orders');
  assert.equal(filtersUrl(NO_FILTERS, 1), '/orders');
  assert.equal(filtersUrl(NO_FILTERS, 3), '/orders?page=3');
  assert.equal(filtersUrl({ ...NO_FILTERS, q: '#1001', needsAction: true }, 2), '/orders?q=%231001&needs_action=1&page=2');
  assert.equal(filtersUrl({ ...NO_FILTERS, flagged: true }), '/orders?risk=flagged');
  const all = { q: 'a b', status: 'partial', payment: 'refunded', from: '2026-01-02', to: '2026-01-03', needsAction: true, flagged: true };
  const round = readFilters(new URLSearchParams(filtersUrl(all).split('?')[1]));
  assert.deepEqual(round, all);
});

test('hasFilters is false only with nothing set', () => {
  assert.equal(hasFilters(NO_FILTERS), false);
  for (const change of [{ q: 'x' }, { status: 'fulfilled' }, { payment: 'paid' }, { from: '2026-01-01' }, { to: '2026-01-01' }, { needsAction: true }, { flagged: true }]) {
    assert.equal(hasFilters({ ...NO_FILTERS, ...change }), true, JSON.stringify(change));
  }
});

test('the API query pages, renames payment, and turns local days into exact instants', () => {
  assert.equal(ordersApiQuery(NO_FILTERS, 1, 50), 'limit=50&offset=0');
  const params = new URLSearchParams(
    ordersApiQuery({ q: 'Smith', status: 'unfulfilled', payment: 'pending', from: '2026-08-03', to: '2026-08-03', needsAction: true, flagged: true }, 3, 50)
  );
  assert.equal(params.get('offset'), '100');
  assert.equal(params.get('financial_status'), 'pending');
  assert.equal(params.get('payment'), null);
  assert.equal(params.get('needs_action'), 'true');
  assert.equal(params.get('risk'), 'flagged');
  assert.equal(params.get('from'), '2026-08-02T16:00:00.000Z', 'midnight on the 3rd in UTC+8');
  assert.equal(params.get('to'), '2026-08-03T15:59:59.999Z', 'the last moment of the 3rd in UTC+8');
});

test('"Back to orders" only goes to an Orders list URL', async () => {
  const { backToList } = await import('../src/lib/orderFilters.ts');
  assert.equal(backToList('/orders?q=smith&page=2'), '/orders?q=smith&page=2');
  assert.equal(backToList('/orders'), '/orders');
  for (const bad of [null, '', 'https://evil.example', '//evil.example/orders', '/settings', '/orders/5', '/ordersx', '/orders?q=1#x', 'javascript:alert(1)']) {
    assert.equal(backToList(bad), '/orders', String(bad));
  }
});
