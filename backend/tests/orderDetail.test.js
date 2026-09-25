const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { lineItemRow } = require('../src/models/orderModel');
const { shopifyAdminUrl } = require('../src/controllers/ordersController');

test('a Shopify line item becomes a row, without its properties', () => {
  const row = lineItemRow(7, {
    id: 111,
    variant_id: 222,
    title: 'Linen shirt',
    variant_title: 'Large / Blue',
    sku: 'LS-L-B',
    quantity: 3,
    fulfillable_quantity: 1,
    price: '45.00',
    properties: [{ name: 'Engraving', value: 'For Ana' }],
  });
  assert.deepEqual(row, [7, '111', '222', 'Linen shirt', 'Large / Blue', 'LS-L-B', 3, 1, '45.00']);
  assert.ok(!JSON.stringify(row).includes('Ana'));
});

test('custom items and missing fields still make a row', () => {
  assert.deepEqual(lineItemRow(7, { id: 5, variant_id: null, name: 'Gift wrap', sku: '', quantity: 1, price: '2.00' }), [
    7, '5', null, 'Gift wrap', null, null, 1, null, '2.00',
  ]);
  assert.equal(lineItemRow(7, { id: 6, title: 'x'.repeat(300), quantity: 1 })[3].length, 255);
});

test('the Shopify admin link needs a real shop domain and a numeric order id', () => {
  assert.equal(shopifyAdminUrl('ai-ops-txmxtrn4.myshopify.com', '6123456789'), 'https://ai-ops-txmxtrn4.myshopify.com/admin/orders/6123456789');
  assert.equal(shopifyAdminUrl(null, '6123456789'), null);
  assert.equal(shopifyAdminUrl('evil.example.com', '6123456789'), null);
  assert.equal(shopifyAdminUrl('shop.myshopify.com/../x', '1'), null);
  assert.equal(shopifyAdminUrl('shop.myshopify.com', 'abc'), null);
});
