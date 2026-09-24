const pool = require('../config/db');
const { getStoreCredentials } = require('../models/sellerModel');
const { fetchVariant } = require('./shopifyService');

// Decides in code, not in the model, whether each line item of an order can
// ship: the model kept overriding stock data with its own assumptions (e.g.
// "gift cards don't need stock"). The agent gets these results as facts.
//
// Stock comes live from Shopify. Shopify takes an order's units off
// "available" the moment the order is created, so by the time the
// orders/create webhook arrives, live stock already counts this order:
// what's left is `available`, and below zero means the store oversold.

// One line item's verdict.
//   live: the variant from Shopify, null if Shopify says it no longer
//         exists, undefined if Shopify couldn't be reached.
//   lastSynced: stock_quantity from our last sync, or undefined if we have none.
function evaluateLine({ title, variantId, quantity }, live, lastSynced) {
  const line = { title, variant_id: variantId, quantity };

  // Custom line items have no variant, so there's no stock to run out of.
  if (!variantId) return { ...line, stock_left_after_order: 'not tracked', can_ship: true, source: 'custom item' };

  if (live === null) {
    return { ...line, stock_left_after_order: 'unknown', can_ship: false, source: 'variant no longer exists in Shopify' };
  }

  if (live) {
    if (!live.inventory_management) return { ...line, stock_left_after_order: 'not tracked', can_ship: true, source: 'shopify' };
    const left = Number(live.inventory_quantity) || 0;
    return { ...line, stock_left_after_order: left, can_ship: left >= 0, source: 'shopify' };
  }

  // Shopify unreachable: fall back to the last sync. We can't tell if that
  // snapshot already counts this order, so assume it doesn't (the stricter
  // reading): a wrong HOLD gets a human look, a wrong FULFILL ships nothing.
  if (lastSynced == null) {
    return { ...line, stock_left_after_order: 'unknown', can_ship: false, source: 'Shopify unreachable, not in last sync' };
  }
  const left = lastSynced - quantity;
  return { ...line, stock_left_after_order: left, can_ship: left >= 0, source: 'last sync (Shopify unreachable)' };
}

// "3 ordered, 2 short" style text for one line, used in the HOLD override message.
function describeShortfall(line) {
  const left = line.stock_left_after_order;
  const stock = typeof left === 'number' ? `${-left} short` : 'stock unknown';
  return `${line.title} (${line.quantity} ordered, ${stock})`;
}

async function checkOrderStock(sellerId, order) {
  const lineItems = order.line_items || [];
  const variantIds = lineItems.filter((li) => li.variant_id != null).map((li) => String(li.variant_id));

  const lastSynced = new Map();
  if (variantIds.length) {
    const [rows] = await pool.query(
      'SELECT shopify_variant_id, stock_quantity FROM inventory_items WHERE seller_id = ? AND shopify_variant_id IN (?)',
      [sellerId, variantIds]
    );
    for (const row of rows) lastSynced.set(row.shopify_variant_id, row.stock_quantity);
  }

  const creds = await getStoreCredentials(sellerId);
  const lines = [];
  for (const li of lineItems) {
    const variantId = li.variant_id != null ? String(li.variant_id) : null;
    const title = `${li.title}${li.variant_title ? ' - ' + li.variant_title : ''}`;

    let live;
    if (variantId && creds) {
      try {
        live = await fetchVariant(creds.shopDomain, creds.accessToken, variantId);
      } catch (err) {
        console.warn(`[stock check seller=${sellerId}] live stock for variant ${variantId} failed: ${err.response?.status || err.message}`);
      }
    }
    lines.push(evaluateLine({ title, variantId, quantity: li.quantity }, live, lastSynced.get(variantId)));
  }

  const short = lines.filter((l) => !l.can_ship);
  return { lines, canShip: short.length === 0, short };
}

module.exports = { checkOrderStock, evaluateLine, describeShortfall };
