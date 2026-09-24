// Registers the Shopify webhooks the backend listens for, pointing at a
// public URL for this backend (e.g. an ngrok tunnel). Topics that already
// point there are left alone; ones pointing at an old tunnel are moved.
// Stores connected with "Connect with Shopify" get these automatically;
// this is for pasted tokens and for moving to a new tunnel URL.
//
// Usage (backend .env must be set up):
//   node scripts/register-webhooks.js https://<your-tunnel>.ngrok-free.app [--seller 1] [--dry-run]
//
// --dry-run only lists what's registered and what would change.
// Shopify signs webhooks created this way with the app's client secret,
// which is what SHOPIFY_API_SECRET (or SHOPIFY_WEBHOOK_SECRET) must be set to.
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const pool = require('../src/config/db');
const { getStoreCredentials, getConnectedSellerIds } = require('../src/models/sellerModel');
const { registerWebhooks } = require('../src/services/webhookSetup');

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

  const { existing, results } = await registerWebhooks(creds, baseUrl, { dryRun });
  console.log(`\nSeller ${sellerId} (${creds.shopDomain}): ${existing.length} webhook(s) registered via the API`);
  for (const w of existing) console.log(`    ${w.topic.padEnd(24)} -> ${w.address}`);

  for (const r of results) {
    const label = `  ${r.topic.padEnd(24)}`;
    if (r.action === 'ok') console.log(`${label} ok (already registered)`);
    else if (r.from) console.log(`${label} ${r.action.replace('-', ' ')} ${r.from} -> ${r.address}`);
    else if (r.action === 'failed') {
      console.log(`${label} FAILED: ${r.error}`);
      process.exitCode = 1;
    } else console.log(`${label} ${r.action.replace('-', ' ')} -> ${r.address}`);
  }
}

async function main() {
  const { baseUrl, sellerId, dryRun } = parseArgs(process.argv.slice(2));
  if (!baseUrl || !baseUrl.startsWith('https://')) {
    throw new Error("Pass the backend's public https URL, e.g. node scripts/register-webhooks.js https://abc.ngrok-free.app");
  }
  const sellerIds = sellerId ? [sellerId] : await getConnectedSellerIds();
  for (const id of sellerIds) await registerFor(id, baseUrl, dryRun);
  if (dryRun) console.log('\nDry run: nothing was changed.');
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
