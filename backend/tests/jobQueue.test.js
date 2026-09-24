const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { retryDelaySeconds } = require('../src/services/jobQueue');
const { slimTrigger } = require('../src/services/agentService');

test('retries back off: 30s, 2 min, 8 min', () => {
  delete process.env.JOB_RETRY_BASE_SECONDS;
  assert.deepEqual([1, 2, 3].map(retryDelaySeconds), [30, 120, 480]);
});

test('JOB_RETRY_BASE_SECONDS changes the base; blank or invalid keeps 30', () => {
  for (const [raw, first] of [['0', 0], ['5', 5], ['', 30], ['soon', 30], ['-1', 30]]) {
    process.env.JOB_RETRY_BASE_SECONDS = raw;
    assert.equal(retryDelaySeconds(1), first, `"${raw}"`);
  }
  delete process.env.JOB_RETRY_BASE_SECONDS;
});

test('a queued order keeps what the agent reads and no customer details', () => {
  const order = {
    id: 5550001,
    name: '#1001',
    financial_status: 'paid',
    total_price: '42.00',
    email: 'buyer@example.com',
    phone: '+10000000000',
    customer: { first_name: 'Ada', last_name: 'Lovelace', email: 'buyer@example.com' },
    shipping_address: { address1: '1 Main St', city: 'Springfield' },
    billing_address: { address1: '1 Main St' },
    line_items: [{ variant_id: 11, title: 'Mug', variant_title: 'Blue', quantity: 2, price: '21.00', properties: [] }],
  };
  const slim = slimTrigger({ type: 'order_created', order });
  assert.deepEqual(slim, {
    type: 'order_created',
    order: {
      id: 5550001,
      name: '#1001',
      financial_status: 'paid',
      total_price: '42.00',
      line_items: [{ variant_id: 11, title: 'Mug', variant_title: 'Blue', quantity: 2 }],
    },
  });
  assert.doesNotMatch(JSON.stringify(slim), /buyer@|Ada|Main St|\+1000/);
});

test('low-stock triggers go in the queue as they are', () => {
  const trigger = { type: 'low_stock_crossed', items: [{ item_name: 'Mug', current_stock: 1 }] };
  assert.equal(slimTrigger(trigger), trigger);
});
