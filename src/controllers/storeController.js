const { isValidShopDomain, setStoreConnection } = require('../models/sellerModel');

// POST /api/store/connect
// Body: { shop_domain, access_token }
// In production with a real Partner-distributed app this would be an OAuth
// redirect flow. For our own dev store, we just paste the token in directly —
// same end result (a token stored per-seller, encrypted), simpler for now.
async function connectStore(req, res) {
  try {
    const { shop_domain, access_token } = req.body;
    if (!shop_domain || !access_token) {
      return res.status(400).json({ error: 'shop_domain and access_token are required' });
    }
    if (!isValidShopDomain(shop_domain)) {
      return res.status(400).json({ error: "shop_domain must be your store's *.myshopify.com domain" });
    }

    await setStoreConnection(req.sellerId, shop_domain, access_token);

    res.json({ message: 'Store connected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not connect store' });
  }
}

module.exports = { connectStore };
