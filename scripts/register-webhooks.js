// Registers the Shopify webhooks the backend listens for, pointing at a
// public URL for this backend (e.g. an ngrok tunnel). Topics that already
// point there are left alone; ones pointing at an old tunnel are moved.
//
// Usage (backend .env must be set up):
//   node scripts/register-webhooks.js https://<your-tunnel>.ngrok-free.app [--seller 1] [--dry-run]
//
// --dry-run only lists what's registered and what would change.
// Shopify signs webhooks created this way with the app's client secret,
// which is what SHOPIFY_WEBHOOK_SECRET must be set to.
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const axios = require('axios');
const pool = require('../src/config/db');
const { getStoreCredentials, getConnectedSellerIds } = require('../src/models/sellerModel');

const API_VERSION = '2024-10';
const TOPICS = {
  'orders/create': '/api/webhooks/orders-create',
  'orders/updated': '/api/webhooks/orders-updated',
  'inventory_levels/update': '/api/webhooks/inventory-levels-update',
};

function parseArgs(argv) {
  const args = { baseUrl: null, sellerId: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--seller') args.sellerId = Number(argv[++i]);
    else if (!args.baseUrl) args.baseUrl = argv[i];
  }
  return args;
}

async function registerFor(sellerId, baseUrl, dryRun) {
  const creds = await getStoreCredentials(sellerId);
  if (!creds) throw new Error(`seller ${sellerId} has no connected store`);
  const shopify = axios.create({
    baseURL: `https://${creds.shopDomain}/admin/api/${API_VERSION}`,
    headers: { 'X-Shopify-Access-Token': creds.accessToken },
    timeout: 20000,
  });

  const { data } = await shopify.get('/webhooks.json', { params: { limit: 250 } });
  console.log(`\nSeller ${sellerId} (${creds.shopDomain}): ${data.webhooks.length} webhook(s) registered via the API`);
  for (const w of data.webhooks) console.log(`    ${w.topic.padEnd(24)} -> ${w.address}`);

  for (const [topic, route] of Object.entries(TOPICS)) {
    const address = baseUrl + route;
    const existing = data.webhooks.filter((w) => w.topic === topic);
    const label = `  ${topic.padEnd(24)}`;
    try {
      if (existing.some((w) => w.address === address)) {
        console.log(`${label} ok (already registered)`);
      } else if (existing.length) {
        if (!dryRun) await shopify.put(`/webhooks/${existing[0].id}.json`, { webhook: { id: existing[0].id, address } });
        console.log(`${label} ${dryRun ? 'would move' : 'moved'} ${existing[0].address} -> ${address}`);
      } else {
        if (!dryRun) await shopify.post('/webhooks.json', { webhook: { topic, address, format: 'json' } });
        console.log(`${label} ${dryRun ? 'would register' : 'registered'} -> ${address}`);
      }
    } catch (err) {
      const detail = err.response ? `HTTP ${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
      console.log(`${label} FAILED: ${detail}`);
      if (err.response?.status === 403) console.log(`${' '.repeat(28)}(the app's access token may be missing a scope, e.g. read_inventory)`);
      process.exitCode = 1;
    }
  }
}

async function main() {
  const { baseUrl, sellerId, dryRun } = parseArgs(process.argv.slice(2));
  if (!baseUrl || !/^https:\/\//.test(baseUrl)) {
    throw new Error('Pass the backend\'s public https URL, e.g. node scripts/register-webhooks.js https://abc.ngrok-free.app');
  }
  const sellerIds = sellerId ? [sellerId] : await getConnectedSellerIds();
  for (const id of sellerIds) await registerFor(id, baseUrl.replace(/\/+$/, ''), dryRun);
  if (dryRun) console.log('\nDry run: nothing was changed.');
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
