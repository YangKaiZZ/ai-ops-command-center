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
// error rather than a 429, so wait and try again here too.
async function graphql(client, query, variables) {
  for (let attempt = 0; ; attempt++) {
    const { data } = await client.post('/graphql.json', { query, variables });
    if (!data.errors?.length) return data.data;
    const throttled = data.errors.every((e) => e.extensions?.code === 'THROTTLED');
    if (!throttled || attempt >= MAX_RETRIES) {
      throw new Error(`Shopify GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
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

module.exports = { fetchOrders, fetchOrder, fetchOrdersByIds, fetchProducts, fetchVariant, fetchOrderRisks, nextPageUrl };
