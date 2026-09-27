const axios = require('axios');

// The Admin API version for every Shopify call (REST, GraphQL, webhooks).
// Shopify supports each version for 12 months; a retired one is answered by
// the oldest still supported, which changes under you. 2026-07 is supported
// until 2027-07-16: move to a newer one before then.
const API_VERSION = '2026-07';
const MAX_PAGES = 400; // stop instead of paging forever on a bad cursor
const MAX_RETRIES = 4;
const ORDERS_PAGE = 50;
const LINE_ITEMS_PAGE = 50; // an order with more gets the rest in follow-up queries
const VARIANTS_PAGE = 250;
const IDS_BATCH = 50; // ids per nodes() query, well inside Shopify's query cost limit

// Everything here goes through the GraphQL Admin API: Shopify calls REST
// legacy, and App Store apps must use GraphQL only. Orders and variants come
// back mapped to the REST field names the rest of the app reads, because the
// webhooks Shopify delivers still use those: one shape, whichever way an
// order came in.
//
// Each seller (tenant) has their own shop domain and token, so the client is
// built per call.
function shopifyClient(shopDomain, accessToken) {
  const client = axios.create({
    baseURL: `https://${shopDomain}/admin/api/${API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  });

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

// A GraphQL query. Shopify answers a throttled one with 200 and a THROTTLED
// error rather than a 429, so wait and try again here too. A missing scope
// comes back as ACCESS_DENIED: the error then has accessDenied set.
// `tolerate(errors)` returning true keeps the (partial) data instead of throwing.
async function graphql(client, query, variables, { tolerate } = {}) {
  for (let attempt = 0; ; attempt++) {
    const { data } = await client.post('/graphql.json', { query, variables });
    if (!data.errors?.length) return data.data;
    if (data.data && tolerate?.(data.errors)) return data.data;
    const throttled = data.errors.every((e) => e.extensions?.code === 'THROTTLED');
    if (!throttled || attempt >= MAX_RETRIES) {
      throw Object.assign(new Error(`Shopify GraphQL: ${data.errors.map((e) => e.message).join('; ')}`), {
        accessDenied: data.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED'),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

// Every page of a connection: `pick(data)` finds it in each answer.
async function allPages(client, query, variables, pick) {
  const nodes = [];
  let cursor = null;
  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) throw new Error(`Stopped after ${MAX_PAGES} pages; sync is incomplete`);
    const connection = pick(await graphql(client, query, { ...variables, cursor }, { tolerate: onlyNamesDenied }));
    nodes.push(...connection.nodes);
    if (!connection.pageInfo.hasNextPage) return nodes;
    cursor = connection.pageInfo.endCursor;
  }
}

const gid = (type, id) => `gid://shopify/${type}/${id}`;
const numericId = (value) => String(value).split('/').pop();

// --- Orders ---

// Without Shopify's approval for protected customer data, an order's
// customer comes with its id but the name fields are refused (ACCESS_DENIED,
// null in the answer). The rest of the order is there: keep it, and the
// dashboard says "Name not shared", as it did with REST. Once Shopify
// approves, the names simply come through.
function onlyNamesDenied(errors) {
  return errors.every(
    (e) =>
      e.extensions?.code === 'ACCESS_DENIED' &&
      Array.isArray(e.path) &&
      e.path.includes('customer') &&
      ['firstName', 'lastName'].includes(e.path.at(-1))
  );
}

const LINE_ITEM_FIELDS = `id title name variantTitle sku quantity unfulfilledQuantity
  variant { id }
  originalUnitPriceSet { shopMoney { amount } }`;

const ORDER_FIELDS = `id name createdAt displayFulfillmentStatus displayFinancialStatus
  totalPriceSet { shopMoney { amount } }
  customer { id firstName lastName }
  lineItems(first: ${LINE_ITEMS_PAGE}) { pageInfo { hasNextPage endCursor } nodes { ${LINE_ITEM_FIELDS} } }`;

const ORDERS_QUERY = `query Orders($cursor: String, $query: String) {
  orders(first: ${ORDERS_PAGE}, after: $cursor, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}`;

const ORDER_NODES_QUERY = `query OrderNodes($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Order { ${ORDER_FIELDS} } }
}`;

const MORE_LINE_ITEMS_QUERY = `query MoreLineItems($id: ID!, $cursor: String) {
  order(id: $id) {
    lineItems(first: 250, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${LINE_ITEM_FIELDS} } }
  }
}`;

// REST's fulfillment_status: null until something ships.
const FULFILLMENT_STATUS = { FULFILLED: 'fulfilled', PARTIALLY_FULFILLED: 'partial', RESTOCKED: 'restocked' };

// A GraphQL LineItem with REST's field names. fulfillable_quantity is what's
// left to ship (unfulfilledQuantity), counting items on hold; the REST
// webhooks count those as 0 until the hold is released.
function toRestLineItem(item) {
  return {
    id: numericId(item.id),
    variant_id: item.variant ? numericId(item.variant.id) : null,
    title: item.title,
    name: item.name,
    variant_title: item.variantTitle ?? null,
    sku: item.sku ?? null,
    quantity: item.quantity,
    fulfillable_quantity: item.unfulfilledQuantity ?? null,
    price: item.originalUnitPriceSet?.shopMoney?.amount ?? null,
  };
}

// A GraphQL Order with the REST fields that orderModel.upsertOrder and the
// agent read (the orders/create and orders/updated webhooks send those).
// createdAt ends in "Z", which MySQL rejects in a DATETIME: it gets "+00:00",
// the same instant in the offset form REST used.
function toRestOrder(node) {
  return {
    id: numericId(node.id),
    name: node.name,
    created_at: node.createdAt ? node.createdAt.replace(/Z$/, '+00:00') : null,
    fulfillment_status: FULFILLMENT_STATUS[node.displayFulfillmentStatus] ?? null,
    financial_status: node.displayFinancialStatus ? node.displayFinancialStatus.toLowerCase() : null,
    total_price: node.totalPriceSet?.shopMoney?.amount ?? null,
    customer: node.customer
      ? { id: numericId(node.customer.id), first_name: node.customer.firstName ?? null, last_name: node.customer.lastName ?? null }
      : null,
    line_items: node.lineItems.nodes.map(toRestLineItem),
  };
}

// toRestOrder, after fetching any line items past the first page (rare).
async function completeOrder(client, node) {
  let { pageInfo } = node.lineItems;
  const items = [...node.lineItems.nodes];
  while (pageInfo.hasNextPage) {
    const { order } = await graphql(client, MORE_LINE_ITEMS_QUERY, { id: node.id, cursor: pageInfo.endCursor });
    if (!order) break;
    items.push(...order.lineItems.nodes);
    pageInfo = order.lineItems.pageInfo;
  }
  return toRestOrder({ ...node, lineItems: { nodes: items } });
}

// Every order in the store (any status). With updatedAtMin, only orders
// created or changed since then.
async function fetchOrders(shopDomain, accessToken, { updatedAtMin } = {}) {
  const client = shopifyClient(shopDomain, accessToken);
  const query = updatedAtMin ? `updated_at:>='${updatedAtMin.toISOString()}'` : null;
  const nodes = await allPages(client, ORDERS_QUERY, { query }, (data) => data.orders);
  const orders = [];
  for (const node of nodes) orders.push(await completeOrder(client, node));
  return orders;
}

// The given orders (any status). An id Shopify no longer has is left out.
async function fetchOrdersByIds(shopDomain, accessToken, ids) {
  const client = shopifyClient(shopDomain, accessToken);
  const orders = [];
  for (let i = 0; i < ids.length; i += IDS_BATCH) {
    const batch = ids.slice(i, i + IDS_BATCH).map((id) => gid('Order', id));
    const { nodes } = await graphql(client, ORDER_NODES_QUERY, { ids: batch }, { tolerate: onlyNamesDenied });
    for (const node of nodes) if (node?.id) orders.push(await completeOrder(client, node));
  }
  return orders;
}

// One order, or null if the store no longer has it.
async function fetchOrder(shopDomain, accessToken, orderId) {
  const [order] = await fetchOrdersByIds(shopDomain, accessToken, [orderId]);
  return order ?? null;
}

// --- Stock ---

const VARIANT_FIELDS = `id title inventoryQuantity
  inventoryItem { id tracked }
  product { id title }`;

const VARIANTS_QUERY = `query Variants($cursor: String) {
  productVariants(first: ${VARIANTS_PAGE}, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { ${VARIANT_FIELDS} }
  }
}`;

const VARIANT_QUERY = `query Variant($id: ID!) { productVariant(id: $id) { ${VARIANT_FIELDS} } }`;

// A GraphQL ProductVariant with REST's field names, plus its product's id and
// title. inventory_management is "shopify" when Shopify tracks its stock,
// null when it doesn't (inventory_quantity then means nothing).
function toRestVariant(node) {
  return {
    id: numericId(node.id),
    product_id: numericId(node.product.id),
    product_title: node.product.title,
    title: node.title,
    inventory_item_id: node.inventoryItem ? numericId(node.inventoryItem.id) : null,
    inventory_quantity: node.inventoryQuantity ?? 0,
    inventory_management: node.inventoryItem?.tracked ? 'shopify' : null,
  };
}

// Every variant of every product (variants hold the actual stock counts).
async function fetchVariants(shopDomain, accessToken) {
  const nodes = await allPages(shopifyClient(shopDomain, accessToken), VARIANTS_QUERY, {}, (data) => data.productVariants);
  return nodes.map(toRestVariant);
}

// One variant's live data (inventory_quantity, inventory_management), or
// null if it no longer exists in the store.
async function fetchVariant(shopDomain, accessToken, variantId) {
  const { productVariant } = await graphql(shopifyClient(shopDomain, accessToken), VARIANT_QUERY, { id: gid('ProductVariant', variantId) });
  return productVariant ? toRestVariant(productVariant) : null;
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
  for (let i = 0; i < orderIds.length; i += IDS_BATCH) {
    const ids = orderIds.slice(i, i + IDS_BATCH).map((id) => `gid://shopify/Order/${id}`);
    const { nodes } = await graphql(client, ORDER_RISK_QUERY, { ids });
    for (const node of nodes) if (node?.id) found.set(node.id.split('/').pop(), node);
  }
  return found;
}

// --- Holding and fulfilling (services/orderActions.js) ---
// Shopify ships an order through its fulfillment orders: one per location the
// items ship from. Each says what can be done with it now (supportedActions)
// and carries its holds. These need write_merchant_managed_fulfillment_orders.

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
  API_VERSION,
  fetchOrders,
  fetchOrder,
  fetchOrdersByIds,
  fetchVariants,
  fetchVariant,
  fetchOrderRisks,
  fetchFulfillmentOrders,
  holdFulfillmentOrder,
  releaseFulfillmentHolds,
  createFulfillment,
  shopifyClient,
  graphql,
  toRestOrder,
  toRestVariant,
  onlyNamesDenied,
};
