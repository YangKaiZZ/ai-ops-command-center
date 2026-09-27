const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const shopify = require('../src/services/shopifyService');
const { topicEnum } = require('../src/services/webhookSetup');

// A fake Shopify behind axios.create: `answer(query, variables)` returns the
// GraphQL response body. Records every request.
function fakeShopify(answer) {
  const requests = [];
  const realCreate = axios.create;
  axios.create = () => ({
    interceptors: { response: { use() {} } },
    async post(url, body) {
      requests.push(body);
      return { data: answer(body.query, body.variables) };
    },
  });
  return { requests, restore: () => (axios.create = realCreate) };
}

const item = (id, extra = {}) => ({
  id: `gid://shopify/LineItem/${id}`,
  title: 'Snowboard',
  name: 'Snowboard - Red',
  variantTitle: 'Red',
  sku: 'SB-1',
  quantity: 2,
  unfulfilledQuantity: 1,
  variant: { id: 'gid://shopify/ProductVariant/77' },
  originalUnitPriceSet: { shopMoney: { amount: '10.00' } },
  ...extra,
});

const orderNode = (id, extra = {}) => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt: '2026-09-21T15:38:00Z',
  displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
  displayFinancialStatus: 'PARTIALLY_REFUNDED',
  totalPriceSet: { shopMoney: { amount: '20.00' } },
  customer: null,
  lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [item(1)] },
  ...extra,
});

const namesDenied = (i) =>
  ['firstName', 'lastName'].map((field) => ({
    message: 'This app is not approved to access the Customer object.',
    path: ['orders', 'nodes', i, 'customer', field],
    extensions: { code: 'ACCESS_DENIED' },
  }));

test('an order gets REST field names, with an offset MySQL accepts', () => {
  const order = shopify.toRestOrder(orderNode(1001));
  assert.deepEqual(order, {
    id: '1001',
    name: '#1001',
    created_at: '2026-09-21T15:38:00+00:00',
    fulfillment_status: 'partial',
    financial_status: 'partially_refunded',
    total_price: '20.00',
    customer: null,
    line_items: [
      {
        id: '1',
        variant_id: '77',
        title: 'Snowboard',
        name: 'Snowboard - Red',
        variant_title: 'Red',
        sku: 'SB-1',
        quantity: 2,
        fulfillable_quantity: 1,
        price: '10.00',
      },
    ],
  });
});

test("fulfillment status is null until something ships, like REST's", () => {
  const status = (s) => shopify.toRestOrder(orderNode(1, { displayFulfillmentStatus: s })).fulfillment_status;
  assert.equal(status('FULFILLED'), 'fulfilled');
  assert.equal(status('UNFULFILLED'), null);
  assert.equal(status('ON_HOLD'), null);
  assert.equal(status('IN_PROGRESS'), null);
});

test('a customer whose name is hidden stays a customer, with no name; a custom item has no variant', () => {
  const order = shopify.toRestOrder(
    orderNode(1, {
      customer: { id: 'gid://shopify/Customer/5', firstName: null, lastName: null },
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [item(2, { variant: null, sku: null, variantTitle: null })] },
    })
  );
  assert.deepEqual(order.customer, { id: '5', first_name: null, last_name: null });
  assert.equal(order.line_items[0].variant_id, null);
  assert.equal(order.line_items[0].sku, null);
});

test('only refused customer names are tolerated, not other refusals', () => {
  assert.equal(shopify.onlyNamesDenied(namesDenied(0)), true);
  assert.equal(shopify.onlyNamesDenied([...namesDenied(0), { path: ['orders'], extensions: { code: 'ACCESS_DENIED' } }]), false);
  assert.equal(shopify.onlyNamesDenied([{ path: ['orders', 'nodes', 0, 'customer', 'email'], extensions: { code: 'ACCESS_DENIED' } }]), false);
  assert.equal(shopify.onlyNamesDenied([{ path: ['orders', 'nodes', 0, 'customer', 'firstName'], extensions: { code: 'THROTTLED' } }]), false);
});

test('fetchOrders follows every page, filters by update time, fetches long orders\' remaining items and keeps orders with hidden names', async () => {
  const fake = fakeShopify((query, vars) => {
    if (query.includes('MoreLineItems')) {
      return { data: { order: { lineItems: { pageInfo: { hasNextPage: false }, nodes: [item(3)] } } } };
    }
    if (!vars.cursor) {
      const long = orderNode(1, {
        customer: { id: 'gid://shopify/Customer/5', firstName: null, lastName: null },
        lineItems: { pageInfo: { hasNextPage: true, endCursor: 'li1' }, nodes: [item(1), item(2)] },
      });
      return { data: { orders: { pageInfo: { hasNextPage: true, endCursor: 'p2' }, nodes: [long] } }, errors: namesDenied(0) };
    }
    return { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [orderNode(2)] } } };
  });
  try {
    const orders = await shopify.fetchOrders('shop.myshopify.com', 'token', { updatedAtMin: new Date('2026-09-20T00:00:00Z') });
    assert.deepEqual(orders.map((o) => o.id), ['1', '2']);
    assert.deepEqual(orders[0].line_items.map((li) => li.id), ['1', '2', '3']);
    assert.equal(orders[0].customer.first_name, null);
    assert.equal(fake.requests[0].variables.query, "updated_at:>='2026-09-20T00:00:00.000Z'");
    assert.equal(fake.requests.find((r) => r.query.includes('MoreLineItems')).variables.cursor, 'li1');
    assert.deepEqual(fake.requests.filter((r) => r.query.includes('query Orders')).map((r) => r.variables.cursor), [null, 'p2']);
  } finally {
    fake.restore();
  }
});

test('any other GraphQL error still fails the fetch', async () => {
  const fake = fakeShopify(() => ({ data: null, errors: [{ message: 'Access denied for orders field.', extensions: { code: 'ACCESS_DENIED' } }] }));
  try {
    await assert.rejects(shopify.fetchOrders('shop.myshopify.com', 'token'), (err) => err.accessDenied === true);
  } finally {
    fake.restore();
  }
});

test('orders by id skip ones Shopify no longer has; a missing order is null', async () => {
  const fake = fakeShopify((query, vars) => ({ data: { nodes: vars.ids.map((id) => (id.endsWith('/404') ? null : orderNode(id.split('/').pop()))) } }));
  try {
    const orders = await shopify.fetchOrdersByIds('shop.myshopify.com', 'token', ['1', '404', '2']);
    assert.deepEqual(orders.map((o) => o.id), ['1', '2']);
    assert.equal(await shopify.fetchOrder('shop.myshopify.com', 'token', '404'), null);
  } finally {
    fake.restore();
  }
});

test('variants carry their product and whether Shopify tracks their stock', async () => {
  const variant = (id, tracked, quantity) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    title: 'Default Title',
    inventoryQuantity: quantity,
    inventoryItem: { id: `gid://shopify/InventoryItem/${id}0`, tracked },
    product: { id: 'gid://shopify/Product/9', title: 'Board' },
  });
  const fake = fakeShopify((query, vars) => {
    if (query.includes('productVariant(id')) return { data: { productVariant: vars.id.endsWith('/404') ? null : variant(5, true, 3) } };
    return vars.cursor
      ? { data: { productVariants: { pageInfo: { hasNextPage: false }, nodes: [variant(2, false, null)] } } }
      : { data: { productVariants: { pageInfo: { hasNextPage: true, endCursor: 'v2' }, nodes: [variant(1, true, 4)] } } };
  });
  try {
    const variants = await shopify.fetchVariants('shop.myshopify.com', 'token');
    assert.deepEqual(variants[0], {
      id: '1',
      product_id: '9',
      product_title: 'Board',
      title: 'Default Title',
      inventory_item_id: '10',
      inventory_quantity: 4,
      inventory_management: 'shopify',
    });
    assert.equal(variants[1].inventory_management, null);
    assert.equal(variants[1].inventory_quantity, 0);
    assert.equal((await shopify.fetchVariant('shop.myshopify.com', 'token', '5')).inventory_quantity, 3);
    assert.equal(await shopify.fetchVariant('shop.myshopify.com', 'token', '404'), null);
  } finally {
    fake.restore();
  }
});

test("webhook topics get GraphQL's enum names", () => {
  assert.equal(topicEnum('orders/create'), 'ORDERS_CREATE');
  assert.equal(topicEnum('inventory_levels/update'), 'INVENTORY_LEVELS_UPDATE');
  assert.equal(topicEnum('app/uninstalled'), 'APP_UNINSTALLED');
});
