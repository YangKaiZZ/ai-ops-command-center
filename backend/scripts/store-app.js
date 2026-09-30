// A real seller's own Shopify app (custom distribution installs an app on one
// store only; see docs/ADD-A-SELLER.md):
//   npm run store-app -- add <store>.myshopify.com   asks for the app's client ID and secret
//   npm run store-app -- list                        every store app, and whether it's connected
//   npm run store-app -- remove <store>.myshopify.com
// On the server: docker compose exec backend npm run store-app -- add <store>
// The secret is typed at a prompt (or piped in), never passed as an argument,
// so it stays out of shell history and the process list.
const path = require('path');
process.chdir(path.join(__dirname, '..')); // so dotenv finds the backend .env

const readline = require('readline');
const pool = require('../src/config/db');
const { normalizeShopDomain } = require('../src/services/shopifyOAuth');
const { findStoreApp, saveStoreApp, removeStoreApp, listStoreApps } = require('../src/models/storeAppModel');

// Reads lines one at a time: from the keyboard (the secret not echoed) or from a pipe.
function prompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const lines = [];
  const waiting = [];
  rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
  rl.on('close', () => waiting.splice(0).forEach((resolve) => resolve('')));
  let hidden = false;
  const write = rl._writeToOutput?.bind(rl);
  if (write) rl._writeToOutput = (text) => write(hidden && !/^[\r\n]+$/.test(text) ? '' : text);
  const ask = (question, { secret = false } = {}) => {
    process.stdout.write(question);
    hidden = secret;
    return new Promise((resolve) => {
      const done = (line) => {
        if (secret) process.stdout.write('\n');
        hidden = false;
        resolve(line.trim());
      };
      lines.length ? done(lines.shift()) : waiting.push(done);
    });
  };
  return { ask, close: () => rl.close() };
}

function storeArg(value) {
  const shop = normalizeShopDomain(value || '');
  if (!shop) throw new Error('Give the store address, like their-store.myshopify.com');
  return shop;
}

async function add(value) {
  const shop = storeArg(value);
  const existing = await findStoreApp(shop);
  const { ask, close } = prompter();
  try {
    console.log(existing ? `${shop} already has an app (client ID ${existing.clientId}); this replaces it.` : `Adding the app for ${shop}.`);
    console.log("From the app's Settings page in the Shopify Dev Dashboard:");
    const clientId = await ask('  Client ID: ');
    const clientSecret = await ask('  Client secret (hidden): ', { secret: true });
    if (!/^[A-Za-z0-9_-]{8,255}$/.test(clientId)) throw new Error("That client ID doesn't look right: copy it again from the app's Settings.");
    if (clientSecret.length < 8 || /\s/.test(clientSecret)) throw new Error("That secret doesn't look right: copy it again from the app's Settings.");
    await saveStoreApp(shop, clientId, clientSecret);
  } finally {
    close();
  }
  console.log(`Saved. ${shop} now connects through its own app.`);
  console.log('Next: send the seller the install link from the Dev Dashboard (Distribution > Custom distribution).');
}

async function list() {
  const apps = await listStoreApps();
  if (!apps.length) return console.log('No store apps yet. Every store uses the server\'s app (SHOPIFY_API_KEY).');
  for (const a of apps) {
    const who = a.seller_id ? `${a.connected ? 'connected' : 'not connected'}: account ${a.seller_id} (${a.business_name})` : 'no account yet';
    console.log(`  ${a.shop_domain.padEnd(40)} ${a.client_id.slice(0, 12)}…  ${who}`);
  }
}

async function remove(value, force) {
  const shop = storeArg(value);
  const connected = (await listStoreApps()).find((a) => a.shop_domain === shop && a.connected);
  if (connected && !force) {
    throw new Error(`${shop} is connected (account ${connected.seller_id}). Without its app the connection stops working; add --force to remove it anyway.`);
  }
  console.log((await removeStoreApp(shop)) ? `Removed the app for ${shop}.` : `${shop} had no app of its own.`);
}

async function main() {
  const [command, value, ...flags] = process.argv.slice(2);
  if (command === 'add') return add(value);
  if (command === 'list') return list();
  if (command === 'remove') return remove(value, flags.includes('--force'));
  console.log('Usage: npm run store-app -- add <store>.myshopify.com | list | remove <store>.myshopify.com [--force]');
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
