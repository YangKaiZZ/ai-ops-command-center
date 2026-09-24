const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { nextPageUrl } = require('../src/services/shopifyService');

const base = 'https://shop.myshopify.com/admin/api/2024-10/orders.json';

test('finds the next-page cursor URL in a Link header', () => {
  assert.equal(nextPageUrl(`<${base}?limit=250&page_info=abc>; rel="next"`), `${base}?limit=250&page_info=abc`);
});

test('picks next, not previous, when both are present', () => {
  const header = `<${base}?limit=250&page_info=prev>; rel="previous", <${base}?limit=250&page_info=nxt>; rel="next"`;
  assert.equal(nextPageUrl(header), `${base}?limit=250&page_info=nxt`);
});

test('last page (no next link, or no header) ends paging', () => {
  assert.equal(nextPageUrl(`<${base}?limit=250&page_info=prev>; rel="previous"`), null);
  assert.equal(nextPageUrl(undefined), null);
});
