const axios = require('axios');

// The Shopify webhooks this backend listens for, and where. Registered
// through the Admin API, so Shopify signs them with the app's client secret.
// (The privacy/compliance topics can't be registered this way; they're set
// in the app's configuration. See the README.)
const API_VERSION = '2024-10';
const WEBHOOK_TOPICS = {
  'orders/create': '/api/webhooks/orders-create',
  'orders/updated': '/api/webhooks/orders-updated',
  'inventory_levels/update': '/api/webhooks/inventory-levels-update',
  'app/uninstalled': '/api/webhooks/app-uninstalled',
};

function adminClient({ shopDomain, accessToken }) {
  return axios.create({
    baseURL: `https://${shopDomain}/admin/api/${API_VERSION}`,
    headers: { 'X-Shopify-Access-Token': accessToken },
    timeout: 20000,
  });
}

// Shopify only delivers webhooks to public https addresses.
function isPublicHttpsUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname !== 'localhost' && !/^127\.|^10\.|^192\.168\./.test(hostname);
  } catch {
    return false;
  }
}

async function listWebhooks(creds) {
  const { data } = await adminClient(creds).get('/webhooks.json', { params: { limit: 250 } });
  return data.webhooks;
}

// Makes every topic point at baseUrl: leaves correct ones alone, moves ones
// pointing at an old address (e.g. a previous ngrok tunnel), creates the rest.
// Returns one result per topic: { topic, address, action, from?, error? }
// where action is ok | moved | registered | would-move | would-register | failed.
async function registerWebhooks(creds, baseUrl, { dryRun = false } = {}) {
  const shopify = adminClient(creds);
  const existing = await listWebhooks(creds);
  const results = [];

  for (const [topic, route] of Object.entries(WEBHOOK_TOPICS)) {
    const address = baseUrl.replace(/\/+$/, '') + route;
    const current = existing.filter((w) => w.topic === topic);
    try {
      if (current.some((w) => w.address === address)) {
        results.push({ topic, address, action: 'ok' });
      } else if (current.length) {
        if (!dryRun) await shopify.put(`/webhooks/${current[0].id}.json`, { webhook: { id: current[0].id, address } });
        results.push({ topic, address, action: dryRun ? 'would-move' : 'moved', from: current[0].address });
      } else {
        if (!dryRun) await shopify.post('/webhooks.json', { webhook: { topic, address, format: 'json' } });
        results.push({ topic, address, action: dryRun ? 'would-register' : 'registered' });
      }
    } catch (err) {
      const status = err.response?.status;
      const detail = status ? `HTTP ${status} ${JSON.stringify(err.response.data)}` : err.message;
      results.push({
        topic,
        address,
        action: 'failed',
        error: status === 403 ? `${detail} (the token may be missing a scope, e.g. read_inventory)` : detail,
      });
    }
  }
  return { existing, results };
}

module.exports = { WEBHOOK_TOPICS, isPublicHttpsUrl, listWebhooks, registerWebhooks };
