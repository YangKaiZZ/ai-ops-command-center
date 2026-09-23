const axios = require('axios');

// Every Shopify Admin REST call needs the shop's domain and its access
// token. We build a fresh axios client per-call because each seller
// (tenant) has their own shop domain and token — this is what makes
// swapping to multi-tenant later trivial.
function shopifyClient(shopDomain, accessToken) {
  return axios.create({
    baseURL: `https://${shopDomain}/admin/api/2024-10`,
    headers: {
      'X-Shopify-Access-Token': accessToken,
      'Content-Type': 'application/json',
    },
  });
}

// Pulls recent orders. Shopify paginates via a Link header (cursor-based,
// not page numbers) — for the MVP we just grab the most recent 50.
async function fetchOrders(shopDomain, accessToken) {
  const client = shopifyClient(shopDomain, accessToken);
  const { data } = await client.get('/orders.json', {
    params: { status: 'any', limit: 50 },
  });
  return data.orders;
}

// Pulls products + their variants (variants hold the actual stock counts).
async function fetchProducts(shopDomain, accessToken) {
  const client = shopifyClient(shopDomain, accessToken);
  const { data } = await client.get('/products.json', {
    params: { limit: 50 },
  });
  return data.products;
}

module.exports = { fetchOrders, fetchProducts };
