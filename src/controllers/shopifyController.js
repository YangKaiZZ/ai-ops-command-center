const oauth = require('../services/shopifyOAuth');
const storeConnection = require('../services/storeConnection');
const { createOAuthState, consumeOAuthState } = require('../models/oauthStateModel');
const { findSellerByShopDomain } = require('../models/sellerModel');

// "Connect with Shopify": the dashboard asks for an approval URL, the seller
// approves on Shopify, Shopify redirects to /callback with a one-time code,
// and we swap it for a token. /install is where Shopify sends a merchant who
// clicks "Install" on Shopify's side (App Store or an install link).

const NOT_CONFIGURED =
  "Connect with Shopify isn't set up on this server yet (it needs SHOPIFY_API_KEY, SHOPIFY_API_SECRET and a public https APP_URL).";
const TAKEN = 'This store is already connected to another AI Ops account.';

// Values Shopify sends must already be exact *.myshopify.com hosts.
function exactShop(value) {
  const shop = oauth.normalizeShopDomain(value);
  return shop && shop === value ? shop : null;
}

// POST /api/shopify/connect   Body: { shop }  (signed-in seller)
// Returns the Shopify approval URL for the dashboard to open.
async function connect(req, res) {
  if (!oauth.isConfigured()) return res.status(503).json({ error: NOT_CONFIGURED });
  const shop = oauth.normalizeShopDomain(req.body?.shop);
  if (!shop) return res.status(400).json({ error: 'Enter your store address, e.g. my-store.myshopify.com' });
  try {
    const holder = await findSellerByShopDomain(shop);
    if (holder?.connected && holder.id !== req.sellerId) return res.status(409).json({ error: TAKEN });
    const state = await createOAuthState(req.sellerId, shop);
    res.json({ authorize_url: oauth.buildAuthorizeUrl(shop, state) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start connecting to Shopify' });
  }
}

// GET /api/shopify/install?shop=...&hmac=...&timestamp=...  (from Shopify, no login)
// A store we know goes straight to approval; a new one signs up first.
async function install(req, res) {
  if (!oauth.isConfigured()) return res.status(503).send(NOT_CONFIGURED);
  const shop = exactShop(req.query.shop);
  if (!shop || !oauth.verifyQueryHmac(req.query) || !oauth.isFreshTimestamp(req.query.timestamp)) {
    return res.status(400).send('This install link is invalid or has expired. Start the install again from Shopify.');
  }
  try {
    const holder = await findSellerByShopDomain(shop);
    if (holder) return res.redirect(oauth.buildAuthorizeUrl(shop, await createOAuthState(holder.id, shop)));
    res.redirect(`${oauth.config().dashboardUrl}/signup?shop=${encodeURIComponent(shop)}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong starting the install. Try again.');
  }
}

// GET /api/shopify/callback?code=...&shop=...&state=...&hmac=...&timestamp=...
// Always ends on the dashboard's Settings page, with ?shopify=connected or an error.
async function callback(req, res) {
  const settingsUrl = `${oauth.config().dashboardUrl}/settings`;
  const fail = (message) => res.redirect(`${settingsUrl}?shopify=error&message=${encodeURIComponent(message)}`);

  const { code, state, timestamp } = req.query;
  const shop = exactShop(req.query.shop);
  if (!shop || !code || !state) return fail('Shopify sent back an incomplete response. Try connecting again.');
  if (!oauth.verifyQueryHmac(req.query)) return fail("The response from Shopify couldn't be verified. Try connecting again.");
  if (!oauth.isFreshTimestamp(timestamp)) return fail('That approval link has expired. Try connecting again.');

  try {
    const pending = await consumeOAuthState(state);
    if (!pending || pending.shop !== shop) {
      return fail('This connection attempt expired or was already used. Start again from Settings.');
    }
    const holder = await findSellerByShopDomain(shop);
    if (holder?.connected && holder.id !== pending.sellerId) return fail(TAKEN);

    let token;
    try {
      token = await oauth.exchangeCode(shop, code);
    } catch (err) {
      console.warn(`[connect] ${shop}: code exchange failed: ${err.response?.status || err.message}`);
      return fail("Shopify didn't accept the connection. Try again.");
    }

    await storeConnection.finishConnection(pending.sellerId, shop, token);
    console.log(`[connect] seller ${pending.sellerId} connected ${shop}`);
    res.redirect(`${settingsUrl}?shopify=connected`);
  } catch (err) {
    console.error(err);
    fail('Something went wrong saving the connection. Try again.');
  }
}

module.exports = { connect, install, callback };
