const oauth = require('../services/shopifyOAuth');
const storeConnection = require('../services/storeConnection');
const { findSellerByShopDomain, getStoreCredentials, clearShopifyToken } = require('../models/sellerModel');

// POST /api/store/connect
// Body: { shop_domain, access_token }
// For a custom app made in the store's own admin, which gives an Admin API
// token to paste instead of going through "Connect with Shopify". The token
// is checked against Shopify before it's saved.
async function connectStore(req, res) {
  const shop = oauth.normalizeShopDomain(req.body?.shop_domain);
  const accessToken = typeof req.body?.access_token === 'string' ? req.body.access_token.trim() : '';
  if (!shop) return res.status(400).json({ error: "Enter your store's address, e.g. my-store.myshopify.com" });
  if (!accessToken) return res.status(400).json({ error: 'Paste the Admin API access token' });

  try {
    const holder = await findSellerByShopDomain(shop);
    if (holder?.connected && holder.id !== req.sellerId) {
      return res.status(409).json({ error: 'This store is already connected to another AI Ops account.' });
    }

    let scopes;
    try {
      scopes = await oauth.fetchGrantedScopes(shop, accessToken);
    } catch (err) {
      const status = err.response?.status;
      if (status === 401 || status === 403 || status === 404) {
        return res.status(400).json({ error: "Shopify didn't accept that token for this store. Check the store address and token." });
      }
      throw err;
    }

    const { webhooks, missingScopes } = await storeConnection.finishConnection(req.sellerId, shop, { accessToken, scopes });
    res.json({ message: 'Store connected', shop_domain: shop, missing_scopes: missingScopes, webhooks });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Could not connect store' });
  }
}

// DELETE /api/store
// Disconnects the store: uninstalls the app on Shopify's side (best effort)
// and forgets the token. Orders, stock and decisions stay.
async function disconnectStore(req, res) {
  try {
    const creds = await getStoreCredentials(req.sellerId);
    if (creds) {
      try {
        await oauth.revokeAccess(creds.shopDomain, creds.accessToken);
      } catch (err) {
        // Already uninstalled, or Shopify unreachable: still disconnect here.
        console.warn(`[disconnect] seller ${req.sellerId}: revoke failed: ${err.response?.status || err.message}`);
      }
    }
    await clearShopifyToken(req.sellerId);
    res.json({ disconnected: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not disconnect the store' });
  }
}

module.exports = { connectStore, disconnectStore };
