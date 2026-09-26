const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { describeFulfillmentOrder, parseHold, parseRelease, parseFulfill } = require('../src/services/orderActions');
const { holdReason, holdNote } = require('../src/services/agentService');

// A fulfillment order as shopifyService.fetchFulfillmentOrders returns it.
const fo = ({ status = 'OPEN', actions = ['CREATE_FULFILLMENT', 'HOLD'], holds = [] } = {}) => ({
  id: '555',
  status,
  assignedLocation: { name: 'Shop floor' },
  supportedActions: actions.map((action) => ({ action })),
  fulfillmentHolds: holds,
  lineItems: { nodes: [{ remainingQuantity: 1, totalQuantity: 2, lineItem: { title: 'Mug', variantTitle: 'Blue', sku: 'MUG-B' } }] },
});
const hold = (ours, reason = 'HIGH_RISK_OF_FRAUD') => ({ id: '9', reason, reasonNotes: 'note', displayReason: 'High risk of fraud', heldByRequestingApp: ours });

test('an open fulfillment order can be held and fulfilled', () => {
  assert.deepEqual(describeFulfillmentOrder(fo()), {
    id: '555',
    status: 'open',
    location: 'Shop floor',
    holds: [],
    items: [{ title: 'Mug', variant_title: 'Blue', sku: 'MUG-B', quantity: 2, remaining: 1 }],
    can_hold: true,
    can_release: false,
    can_fulfill: true,
  });
});

test('our hold can be released, not held again; another app\'s hold is shown but not ours to release', () => {
  const ours = describeFulfillmentOrder(fo({ status: 'ON_HOLD', actions: ['RELEASE_HOLD', 'HOLD'], holds: [hold(true)] }));
  assert.deepEqual([ours.status, ours.can_hold, ours.can_release, ours.can_fulfill], ['on_hold', false, true, false]);
  assert.deepEqual(ours.holds, [{ reason: 'HIGH_RISK_OF_FRAUD', label: 'High risk of fraud', note: 'note', ours: true }]);
  const theirs = describeFulfillmentOrder(fo({ status: 'ON_HOLD', actions: ['RELEASE_HOLD', 'HOLD'], holds: [hold(false, 'OTHER')] }));
  assert.deepEqual([theirs.can_hold, theirs.can_release], [true, false]);
});

test('only what Shopify says is possible now', () => {
  const shipped = describeFulfillmentOrder(fo({ status: 'CLOSED', actions: [] }));
  assert.deepEqual([shipped.status, shipped.can_hold, shipped.can_release, shipped.can_fulfill], ['closed', false, false, false]);
});

test('hold: a fulfillment order, a known reason and an optional note', () => {
  assert.deepEqual(parseHold({ fulfillment_order_id: '555', reason: 'HIGH_RISK_OF_FRAUD', note: '  check the buyer  ' }), {
    fulfillmentOrderId: '555',
    reason: 'HIGH_RISK_OF_FRAUD',
    note: 'check the buyer',
  });
  assert.equal(parseHold({ fulfillment_order_id: '555', reason: 'OTHER' }).note, null);
  assert.match(parseHold({ fulfillment_order_id: 555, reason: 'OTHER' }).error, /fulfillment_order_id/);
  assert.match(parseHold({ fulfillment_order_id: 'gid://shopify/FulfillmentOrder/1', reason: 'OTHER' }).error, /fulfillment_order_id/);
  assert.match(parseHold({ fulfillment_order_id: '555', reason: 'BORED' }).error, /reason must be one of/);
  assert.match(parseHold({ fulfillment_order_id: '555', reason: 'toString' }).error, /reason must be one of/);
  assert.match(parseHold({ fulfillment_order_id: '555', reason: 'OTHER', note: 'x'.repeat(256) }).error, /note/);
  assert.match(parseHold(undefined).error, /fulfillment_order_id/);
});

test('release: just the fulfillment order', () => {
  assert.deepEqual(parseRelease({ fulfillment_order_id: '555' }), { fulfillmentOrderId: '555' });
  assert.match(parseRelease({}).error, /fulfillment_order_id/);
});

test('fulfill: tracking is optional, but a carrier or link needs the number', () => {
  assert.deepEqual(parseFulfill({ fulfillment_order_id: '555' }), { fulfillmentOrderId: '555', notifyCustomer: false, tracking: null });
  assert.deepEqual(
    parseFulfill({ fulfillment_order_id: '555', notify_customer: true, tracking_number: ' 1Z999 ', tracking_company: 'UPS', tracking_url: 'https://ups.example/1Z999' }),
    { fulfillmentOrderId: '555', notifyCustomer: true, tracking: { number: '1Z999', company: 'UPS', url: 'https://ups.example/1Z999' } }
  );
  assert.deepEqual(parseFulfill({ fulfillment_order_id: '555', tracking_number: 'AB1', tracking_company: '' }).tracking, { number: 'AB1' });
  assert.match(parseFulfill({ fulfillment_order_id: '555', tracking_company: 'UPS' }).error, /tracking number too/);
  assert.match(parseFulfill({ fulfillment_order_id: '555', notify_customer: 'yes' }).error, /notify_customer/);
  assert.match(parseFulfill({ fulfillment_order_id: '555', tracking_number: 'A1', tracking_url: 'javascript:alert(1)' }).error, /tracking_url/);
  assert.match(parseFulfill({ fulfillment_order_id: '555', tracking_number: 'x'.repeat(101) }).error, /tracking_number/);
  assert.match(parseFulfill({ fulfillment_order_id: '555', tracking_number: 42 }).error, /tracking_number/);
});

test("auto-hold's reason: fraud first, then stock, then payment", () => {
  const short = { canShip: false };
  const ok = { canShip: true };
  const paid = { financial_status: 'paid' };
  assert.equal(holdReason({ level: 'medium', recommendation: 'none' }, short, paid), 'HIGH_RISK_OF_FRAUD');
  assert.equal(holdReason({ level: 'low', recommendation: 'accept' }, short, paid), 'INVENTORY_OUT_OF_STOCK');
  assert.equal(holdReason(null, ok, { financial_status: 'pending' }), 'AWAITING_PAYMENT');
  assert.equal(holdReason({ level: 'unknown', recommendation: 'none', error: 'x' }, ok, paid), 'OTHER');
});

test("the hold's note is the agent's headline", () => {
  assert.equal(holdNote('HOLD - Payment still pending\n- wait for it'), 'Payment still pending');
  assert.equal(holdNote('**HOLD**: fraud check says cancel'), 'fraud check says cancel');
  assert.equal(holdNote(''), null);
  assert.equal(holdNote(`HOLD - ${'x'.repeat(300)}`).length, 255);
});
