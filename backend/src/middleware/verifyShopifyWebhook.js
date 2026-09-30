const crypto = require('crypto');
const { normalizeShopDomain, secretsFor } = require('../services/shopifyOAuth');

// Shopify signs every webhook: X-Shopify-Hmac-Sha256 is the base64
// HMAC-SHA256 of the raw request body, keyed with the app's client secret.
// Needs the *raw* bytes — re-serialized JSON won't match — so the route must
// use express.raw(), not express.json(). The app is the one for the store in
// X-Shopify-Shop-Domain: its own, else the server's (oauth.secretsFor).
async function verifyShopifyWebhook(req, res, next) {
  try {
    const shop = normalizeShopDomain(req.get('X-Shopify-Shop-Domain') || '');
    const secrets = await secretsFor(shop);
    if (!secrets.length) {
      console.error('[webhook] no app secret for this store and SHOPIFY_API_SECRET is not set - rejecting webhook');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    if (!Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: 'Expected a raw JSON body' });
    }

    const received = Buffer.from(req.get('X-Shopify-Hmac-Sha256') || '', 'base64');
    // timingSafeEqual throws on length mismatch, so check that first.
    const signedWith = (secret) => {
      const expected = crypto.createHmac('sha256', secret).update(req.body).digest();
      return received.length === expected.length && crypto.timingSafeEqual(received, expected);
    };
    if (!secrets.some(signedWith)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = verifyShopifyWebhook;
