const { shopifyClient, graphql } = require('./shopifyService');

// The Shopify webhooks this backend listens for, and where. Registered
// through the GraphQL Admin API, so Shopify signs them with the app's client
// secret. (The privacy/compliance topics can't be registered this way;
// they're set in the app's configuration. See the README.)
const WEBHOOK_TOPICS = {
  'orders/create': '/api/webhooks/orders-create',
  'orders/updated': '/api/webhooks/orders-updated',
  'inventory_levels/update': '/api/webhooks/inventory-levels-update',
  'app/uninstalled': '/api/webhooks/app-uninstalled',
};

// "inventory_levels/update" -> INVENTORY_LEVELS_UPDATE, GraphQL's name for the topic.
const topicEnum = (topic) => topic.toUpperCase().replace('/', '_');

// Shopify only delivers webhooks to public https addresses.
function isPublicHttpsUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname !== 'localhost' && !/^127\.|^10\.|^192\.168\./.test(hostname);
  } catch {
    return false;
  }
}

const LIST_QUERY = `query Webhooks($cursor: String) {
  webhookSubscriptions(first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes { id topic uri }
  }
}`;

const CREATE_MUTATION = `mutation Create($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

const UPDATE_MUTATION = `mutation Update($id: ID!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionUpdate(id: $id, webhookSubscription: $sub) {
    webhookSubscription { id }
    userErrors { field message }
  }
}`;

// Every subscription this app has on the store, as { id, topic, address }.
// A topic we listen for keeps its REST-style name ("orders/create"); any
// other shows as Shopify's enum.
async function listWebhooks(creds) {
  const client = shopifyClient(creds.shopDomain, creds.accessToken);
  const names = new Map(Object.keys(WEBHOOK_TOPICS).map((topic) => [topicEnum(topic), topic]));
  const found = [];
  let cursor = null;
  do {
    const { webhookSubscriptions: page } = await graphql(client, LIST_QUERY, { cursor });
    for (const w of page.nodes) found.push({ id: w.id, topic: names.get(w.topic) || w.topic, address: w.uri });
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return found;
}

// A mutation that throws with Shopify's own words when it refused (userErrors).
async function mutate(client, mutation, variables, field) {
  const result = (await graphql(client, mutation, variables))[field];
  if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join('; '));
  return result;
}

// Makes every topic point at baseUrl: leaves correct ones alone, moves ones
// pointing at an old address (e.g. a previous ngrok tunnel), creates the rest.
// Returns one result per topic: { topic, address, action, from?, error? }
// where action is ok | moved | registered | would-move | would-register | failed.
async function registerWebhooks(creds, baseUrl, { dryRun = false } = {}) {
  const client = shopifyClient(creds.shopDomain, creds.accessToken);
  const existing = await listWebhooks(creds);
  const results = [];

  for (const [topic, route] of Object.entries(WEBHOOK_TOPICS)) {
    const address = baseUrl.replace(/\/+$/, '') + route;
    const current = existing.filter((w) => w.topic === topic);
    try {
      if (current.some((w) => w.address === address)) {
        results.push({ topic, address, action: 'ok' });
      } else if (current.length) {
        if (!dryRun) await mutate(client, UPDATE_MUTATION, { id: current[0].id, sub: { uri: address } }, 'webhookSubscriptionUpdate');
        results.push({ topic, address, action: dryRun ? 'would-move' : 'moved', from: current[0].address });
      } else {
        if (!dryRun) {
          await mutate(client, CREATE_MUTATION, { topic: topicEnum(topic), sub: { uri: address, format: 'JSON' } }, 'webhookSubscriptionCreate');
        }
        results.push({ topic, address, action: dryRun ? 'would-register' : 'registered' });
      }
    } catch (err) {
      results.push({
        topic,
        address,
        action: 'failed',
        error: err.accessDenied ? `${err.message} (the token may be missing a scope, e.g. read_inventory)` : err.message,
      });
    }
  }
  return { existing, results };
}

module.exports = { WEBHOOK_TOPICS, topicEnum, isPublicHttpsUrl, listWebhooks, registerWebhooks };
