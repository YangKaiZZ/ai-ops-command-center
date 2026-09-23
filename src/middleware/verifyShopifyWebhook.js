const crypto = require('crypto');

// Shopify signs every webhook: X-Shopify-Hmac-Sha256 is the base64
// HMAC-SHA256 of the raw request body, keyed with the app's webhook secret.
// Needs the *raw* bytes — re-serialized JSON won't match — so the route must
// use express.raw(), not express.json().
function verifyShopifyWebhook(req, res, next) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook] SHOPIFY_WEBHOOK_SECRET is not set - rejecting webhook');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ error: 'Expected a raw JSON body' });
  }

  const expected = crypto.createHmac('sha256', secret).update(req.body).digest();
  const received = Buffer.from(req.get('X-Shopify-Hmac-Sha256') || '', 'base64');

  // timingSafeEqual throws on length mismatch, so check that first.
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

module.exports = verifyShopifyWebhook;
