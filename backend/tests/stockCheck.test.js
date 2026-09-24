const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { evaluateLine, describeShortfall } = require('../src/services/stockCheck');
const { enforceStockCheck } = require('../src/services/agentService');

const item = { title: 'Snowboard', variantId: '42', quantity: 3 };
const tracked = (qty) => ({ inventory_management: 'shopify', inventory_quantity: qty });

test('live stock already counts the order: 0 left can ship, below 0 cannot', () => {
  assert.equal(evaluateLine(item, tracked(0)).can_ship, true);
  assert.equal(evaluateLine(item, tracked(5)).stock_left_after_order, 5);
  const oversold = evaluateLine(item, tracked(-2));
  assert.equal(oversold.can_ship, false);
  assert.equal(oversold.stock_left_after_order, -2);
  assert.equal(oversold.source, 'shopify');
});

test('untracked variants and custom items have no stock limit', () => {
  assert.equal(evaluateLine(item, { inventory_management: null, inventory_quantity: 0 }).can_ship, true);
  const custom = evaluateLine({ ...item, variantId: null }, undefined);
  assert.equal(custom.can_ship, true);
  assert.equal(custom.stock_left_after_order, 'not tracked');
});

test('a variant deleted from Shopify cannot be confirmed, so it holds', () => {
  const line = evaluateLine(item, null, 10);
  assert.equal(line.can_ship, false);
  assert.equal(line.stock_left_after_order, 'unknown');
});

test('Shopify unreachable: last sync is read strictly (as if it excludes this order)', () => {
  assert.equal(evaluateLine(item, undefined, 3).can_ship, true); // 3 - 3 = 0
  const short = evaluateLine(item, undefined, 2);
  assert.equal(short.can_ship, false);
  assert.equal(short.stock_left_after_order, -1);
  assert.match(short.source, /last sync/);
  assert.equal(evaluateLine(item, undefined, undefined).can_ship, false); // no data at all
});

test('shortfall text', () => {
  assert.equal(describeShortfall(evaluateLine(item, tracked(-2))), 'Snowboard (3 ordered, 2 short)');
  assert.equal(describeShortfall(evaluateLine(item, null)), 'Snowboard (3 ordered, stock unknown)');
});

test('stock data overrides a model that says FULFILL for an unshippable order', () => {
  const line = evaluateLine(item, tracked(-1));
  const stockCheck = { lines: [line], canShip: false, short: [line] };
  const result = enforceStockCheck('FULFILL - all good\n- ships today', stockCheck);
  assert.equal(result.overridden, true);
  assert.match(result.reasoning, /^HOLD - stock check: Snowboard \(3 ordered, 1 short\)/);
  assert.equal(enforceStockCheck('HOLD - short on Snowboard', stockCheck).overridden, false);
  assert.equal(enforceStockCheck('FULFILL - ok', { lines: [], canShip: true, short: [] }).overridden, false);
});
