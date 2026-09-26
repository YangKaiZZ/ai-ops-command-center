const axios = require('axios');

const API_VERSION = '2024-10';
const PAGE_SIZE = 250; // Shopify's REST maximum
const MAX_PAGES = 400; // 100k records: stop instead of paging forever on a bad cursor
const MAX_RETRIES = 4;

// Every Shopify Admin REST call needs the shop's domain and its access
// token. We build a fresh axios client per-call because each seller
// (tenant) has their own shop domain and token.
function shopifyClient(shopDomain, accessToken) {
  const client = axios.create({
    baseURL: `https://${shopDomain}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });

  // Shopify rate-limits per store (a leaky bucket, about 2 requests/second).
  // A 429 says how long to wait in Retry-After, so wait and try again.
  client.interceptors.response.use(null, async (error) => {
    const { config, response } = error;
    if (response?.status !== 429 || !config || (config.retries || 0) >= MAX_RETRIES) throw error;
    config.retries = (config.retries || 0) + 1;
    const waitSeconds = Math.min(Number(response.headers['retry-after']) || 2, 10);
    await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    return client.request(config);
  });

  return client;
}

// Shopify paginates with a Link header holding cursor URLs, e.g.
//   <https://shop/admin/api/2024-10/orders.json?limit=250&page_info=abc>; rel="next"
function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

// Follows the Link header until the last page. The next-page URL carries the
// cursor and the original filters, so later requests send no params of their own.
async function fetchAllPages(client, path, params, key) {
  const items = [];
  let url = path;
  let pageParams = { limit: PAGE_SIZE, ...params };
  for (let page = 0; url; page++) {
    if (page === MAX_PAGES) throw new Error(`Stopped after ${MAX_PAGES} pages of ${key}; sync is incomplete`);
    const response = await client.get(url, { params: pageParams });
    items.push(...response.data[key]);
    url = nextPageUrl(response.headers.link);
    pageParams = undefined;
  }
  return items;
}

// Every order in the store (any status), newest first. With updatedAtMin,
// only orders created or changed since then.
async function fetchOrders(shopDomain, accessToken, { updatedAtMin } = {}) {
  const params = { status: 'any' };
  if (updatedAtMin) params.updated_at_min = updatedAtMin.toISOString();
  return fetchAllPages(shopifyClient(shopDomain, accessToken), '/orders.json', params, 'orders');
}

// The given orders (any status). An id Shopify no longer has is left out.
async function fetchOrdersByIds(shopDomain, accessToken, ids) {
  if (!ids.length) return [];
  return fetchAllPages(shopifyClient(shopDomain, accessToken), '/orders.json', { status: 'any', ids: ids.join(',') }, 'orders');
}

// Every product with its variants (variants hold the actual stock counts).
async function fetchProducts(shopDomain, accessToken) {
  return fetchAllPages(shopifyClient(shopDomain, accessToken), '/products.json', {}, 'products');
}

// One variant's live data (inventory_quantity, inventory_management), or
// null if it no longer exists in the store.
async function fetchVariant(shopDomain, accessToken, variantId) {
  try {
    const { data } = await shopifyClient(shopDomain, accessToken).get(`/variants/${encodeURIComponent(variantId)}.json`);
    return data.variant;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// One order, or null if the store no longer has it.
async function fetchOrder(shopDomain, accessToken, orderId) {
  try {
    const { data } = await shopifyClient(shopDomain, accessToken).get(`/orders/${encodeURIComponent(orderId)}.json`);
    return data.order;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

// Shopify's fraud analysis only comes from the GraphQL Admin API (the REST
// OrderRisk resource is deprecated). Read with read_orders, like the orders.
const ORDER_RISK_QUERY = `query OrderRisks($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id
      requiresShipping
      billingAddressMatchesShippingAddress
      risk {
        recommendation
        assessments { riskLevel facts { description sentiment } }
      }
    }
  }
}`;
const RISK_BATCH = 50; // orders per query, well inside Shopify's query cost limit

// A GraphQL query. Shopify answers a throttled one with 200 and a THROTTLED
// error rather than a 429, so wait and try again here too. A missing scope
// comes back as ACCESS_DENIED: the error then has accessDenied set.
async function graphql(client, query, variables) {
  for (let attempt = 0; ; attempt++) {
    const { data } = await client.post('/graphql.json', { query, variables });
    if (!data.errors?.length) return data.data;
    const throttled = data.errors.every((e) => e.extensions?.code === 'THROTTLED');
    if (!throttled || attempt >= MAX_RETRIES) {
      throw Object.assign(new Error(`Shopify GraphQL: ${data.errors.map((e) => e.message).join('; ')}`), {
        accessDenied: data.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED'),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// A mutation's answer, or throws with Shopify's own words when it refused
// (userErrors, e.g. "The fulfillment order is on hold"): err.userError is set.
async function mutate(client, mutation, variables, field) {
  const result = (await graphql(client, mutation, variables))[field];
  if (result.userErrors?.length) {
    throw Object.assign(new Error(result.userErrors.map((e) => e.message).join('; ')), { userError: true });
  }
  return result;
}

// The fraud analysis of the given orders, as a Map of order id (a string) ->
// { requiresShipping, billingAddressMatchesShippingAddress, risk }. An order
// Shopify no longer has is left out.
async function fetchOrderRisks(shopDomain, accessToken, orderIds) {
  const found = new Map();
  const client = shopifyClient(shopDomain, accessToken);
  for (let i = 0; i < orderIds.length; i += RISK_BATCH) {
    const ids = orderIds.slice(i, i + RISK_BATCH).map((id) => `gid://shopify/Order/${id}`);
    const { nodes } = await graphql(client, ORDER_RISK_QUERY, { ids });
    for (const node of nodes) if (node?.id) found.set(node.id.split('/').pop(), node);
  }
  return found;
}

// --- Holding and fulfilling (services/orderActions.js) ---
// Shopify ships an order through its fulfillment orders: one per location the
// items ship from. Each says what can be done with it now (supportedActions)
// and carries its holds. These need write_merchant_managed_fulfillment_orders.

const gid = (type, id) => `gid://shopify/${type}/${id}`;
const numericId = (value) => String(value).split('/').pop();

const FULFILLMENT_ORDERS_QUERY = `query FulfillmentOrders($id: ID!) {
  order(id: $id) {
    fulfillmentOrders(first: 20) {
      nodes {
        id
        status
        assignedLocation { name }
        supportedActions { action }
        fulfillmentHolds { id reason reasonNotes displayReason heldByRequestingApp }
        lineItems(first: 50) {
          nodes { remainingQuantity totalQuantity lineItem { title variantTitle sku } }
        }
      }
    }
  }
}`;

// The order's fulfillment orders as Shopify returns them (ids as numbers in
// strings), or null if Shopify no longer has the order.
async function fetchFulfillmentOrders(shopDomain, accessToken, orderId) {
  const { order } = await graphql(shopifyClient(shopDomain, accessToken), FULFILLMENT_ORDERS_QUERY, { id: gid('Order', orderId) });
  if (!order) return null;
  return order.fulfillmentOrders.nodes.map((fo) => ({
    ...fo,
    id: numericId(fo.id),
    fulfillmentHolds: fo.fulfillmentHolds.map((hold) => ({ ...hold, id: numericId(hold.id) })),
  }));
}

const HOLD_MUTATION = `mutation Hold($id: ID!, $hold: FulfillmentOrderHoldInput!) {
  fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) {
    fulfillmentHold { id }
    userErrors { field message }
  }
}`;

// Puts one fulfillment order on hold: { reason (FulfillmentHoldReason), reasonNotes, handle }.
async function holdFulfillmentOrder(shopDomain, accessToken, fulfillmentOrderId, { reason, reasonNotes, handle }) {
  const hold = { reason, reasonNotes, handle, notifyMerchant: false };
  const result = await mutate(shopifyClient(shopDomain, accessToken), HOLD_MUTATION, { id: gid('FulfillmentOrder', fulfillmentOrderId), hold }, 'fulfillmentOrderHold');
  return { holdId: result.fulfillmentHold ? numericId(result.fulfillmentHold.id) : null };
}

const RELEASE_MUTATION = `mutation Release($id: ID!, $holdIds: [ID!]) {
  fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) {
    fulfillmentOrder { id status }
    userErrors { field message }
  }
}`;

// Releases the given holds (only these: other apps' holds stay).
async function releaseFulfillmentHolds(shopDomain, accessToken, fulfillmentOrderId, holdIds) {
  const variables = { id: gid('FulfillmentOrder', fulfillmentOrderId), holdIds: holdIds.map((id) => gid('FulfillmentHold', id)) };
  const result = await mutate(shopifyClient(shopDomain, accessToken), RELEASE_MUTATION, variables, 'fulfillmentOrderReleaseHold');
  return { status: result.fulfillmentOrder?.status ?? null };
}

// fulfillmentCreate, not fulfillmentCreateV2: Shopify deprecated V2, and a
// request for a retired API version is answered by a newer one anyway.
const FULFILL_MUTATION = `mutation Fulfill($fulfillment: FulfillmentInput!) {
  fulfillmentCreate(fulfillment: $fulfillment) {
    fulfillment { id status }
    userErrors { field message }
  }
}`;

// Ships everything still to ship in one fulfillment order:
// { notifyCustomer, tracking: { number, company, url } | null }.
async function createFulfillment(shopDomain, accessToken, fulfillmentOrderId, { notifyCustomer, tracking }) {
  const fulfillment = {
    lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: gid('FulfillmentOrder', fulfillmentOrderId) }],
    notifyCustomer,
    ...(tracking ? { trackingInfo: tracking } : {}),
  };
  const result = await mutate(shopifyClient(shopDomain, accessToken), FULFILL_MUTATION, { fulfillment }, 'fulfillmentCreate');
  return { fulfillmentId: result.fulfillment ? numericId(result.fulfillment.id) : null };
}

module.exports = {
  fetchOrders,
  fetchOrder,
  fetchOrdersByIds,
  fetchProducts,
  fetchVariant,
  fetchOrderRisks,
  fetchFulfillmentOrders,
  holdFulfillmentOrder,
  releaseFulfillmentHolds,
  createFulfillment,
  nextPageUrl,
};
