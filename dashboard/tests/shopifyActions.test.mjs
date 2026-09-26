// Run with: npm test  (Node strips the TypeScript types itself)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdReasonLabel, fulfillmentStatus, itemsToShip, describeAction, scopeUses } from '../src/lib/shopifyActions.ts';

test('hold reasons in words; anything unknown is "Other"', () => {
  assert.equal(holdReasonLabel('HIGH_RISK_OF_FRAUD'), 'High risk of fraud');
  assert.equal(holdReasonLabel('AWAITING_PAYMENT'), 'Awaiting payment');
  assert.equal(holdReasonLabel('SOMETHING_NEW'), 'Other');
  assert.equal(holdReasonLabel(null), 'Other');
});

test('fulfillment statuses as badges', () => {
  assert.deepEqual(fulfillmentStatus('open'), { label: 'Not shipped', tone: 'neutral', icon: 'todo' });
  assert.equal(fulfillmentStatus('on_hold').label, 'On hold');
  assert.equal(fulfillmentStatus('closed').tone, 'good');
  assert.equal(fulfillmentStatus('incomplete').label, 'Incomplete');
});

test('how much is left to ship', () => {
  const items = (...pairs) => ({ items: pairs.map(([quantity, remaining]) => ({ quantity, remaining })) });
  assert.equal(itemsToShip(items([2, 2], [1, 1])), '3 items to ship');
  assert.equal(itemsToShip(items([2, 1], [1, 0])), '1 of 3 items still to ship');
  assert.equal(itemsToShip(items([2, 0], [1, 0])), 'All 3 items shipped');
  assert.equal(itemsToShip(items([1, 0])), 'Shipped');
});

test('the log in words: who did what, and why it failed', () => {
  const at = { fulfillment_order_id: '1', created_at: '2026-09-26T02:00:00Z', error: null, ok: true };
  assert.deepEqual(describeAction({ ...at, action: 'hold', source: 'agent', reason: 'AWAITING_PAYMENT', note: 'Payment still pending' }), {
    who: 'The agent',
    text: 'put it on hold (awaiting payment): Payment still pending',
  });
  assert.equal(describeAction({ ...at, action: 'release', source: 'seller', reason: null, note: null }).text, 'released the hold');
  assert.equal(describeAction({ ...at, action: 'fulfill', source: 'seller', reason: null, note: '1Z999' }).text, 'marked it fulfilled, tracking 1Z999');
  assert.equal(describeAction({ ...at, action: 'fulfill', source: 'seller', reason: null, note: null }).text, 'marked it fulfilled');
  assert.equal(
    describeAction({ ...at, action: 'hold', source: 'seller', reason: 'OTHER', note: null, ok: false, error: 'Shopify said: no' }).text,
    "tried to put it on hold, but it didn't work: Shopify said: no"
  );
});

test('what missing permissions stop', () => {
  assert.equal(scopeUses(['write_merchant_managed_fulfillment_orders']), 'holding and fulfilling orders from here');
  assert.equal(scopeUses(['read_inventory', 'write_merchant_managed_fulfillment_orders']), 'stock levels and holding and fulfilling orders from here');
  assert.equal(scopeUses(['read_orders', 'read_products', 'read_inventory']), 'orders, products and stock levels');
  assert.equal(scopeUses(['write_something_new']), 'write_something_new');
});
