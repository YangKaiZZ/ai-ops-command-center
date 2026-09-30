const test = require('node:test');
const assert = require('node:assert/strict');
const { installTicket, isValidInstallTicket, TTL_HOURS } = require('../src/services/installTickets');

const SHOP = 'their-store.myshopify.com';

test('a ticket is valid for its own store', () => {
  assert.equal(isValidInstallTicket(SHOP, installTicket(SHOP)), true);
});

test('a ticket for one store does not work for another', () => {
  assert.equal(isValidInstallTicket('other-store.myshopify.com', installTicket(SHOP)), false);
});

test('a ticket expires after a day', () => {
  const made = Date.now();
  const ticket = installTicket(SHOP, made);
  assert.equal(isValidInstallTicket(SHOP, ticket, made + (TTL_HOURS * 3600 - 60) * 1000), true);
  assert.equal(isValidInstallTicket(SHOP, ticket, made + (TTL_HOURS * 3600 + 60) * 1000), false);
});

test('a changed expiry or signature is refused', () => {
  const [expires, signature] = installTicket(SHOP).split('.');
  assert.equal(isValidInstallTicket(SHOP, `${Number(expires) + 86400}.${signature}`), false);
  assert.equal(isValidInstallTicket(SHOP, `${expires}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`), false);
});

test('missing or malformed tickets are refused', () => {
  for (const bad of [undefined, null, '', 'nope', '123.', `.${'a'.repeat(43)}`, 42]) {
    assert.equal(isValidInstallTicket(SHOP, bad), false, String(bad));
  }
  assert.equal(isValidInstallTicket(undefined, installTicket(SHOP)), false);
});
