const pool = require('../config/db');
const { fetchOrders, fetchProducts } = require('../services/shopifyService');
const { upsertOrder } = require('../models/orderModel');
const { triggerAgent } = require('../services/agentService');

// Small helper: every sync route needs this seller's stored Shopify
// credentials before it can call the API.
async function getStoreCredentials(sellerId) {
  const [rows] = await pool.query(
    'SELECT shopify_shop_domain, shopify_access_token FROM sellers WHERE id = ?',
    [sellerId]
  );
  const seller = rows[0];
  if (!seller || !seller.shopify_shop_domain || !seller.shopify_access_token) {
    return null;
  }
  return seller;
}

// POST /api/orders/sync
// Pulls live orders from Shopify and upserts them into our orders table.
async function syncOrders(req, res) {
  try {
    const creds = await getStoreCredentials(req.sellerId);
    if (!creds) {
      return res.status(400).json({ error: 'Connect your Shopify store first via /api/store/connect' });
    }

    const orders = await fetchOrders(creds.shopify_shop_domain, creds.shopify_access_token);

    for (const order of orders) {
      await upsertOrder(req.sellerId, order);
    }

    res.json({ message: `Synced ${orders.length} orders` });
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Could not sync orders from Shopify' });
  }
}

// POST /api/inventory/sync
// Pulls products + variants from Shopify, flattens variants into inventory rows.
async function syncInventory(req, res) {
  try {
    const creds = await getStoreCredentials(req.sellerId);
    if (!creds) {
      return res.status(400).json({ error: 'Connect your Shopify store first via /api/store/connect' });
    }

    const products = await fetchProducts(creds.shopify_shop_domain, creds.shopify_access_token);
    let count = 0;
    const untrackedVariantIds = [];

    // Snapshot stock before the upsert so we can tell which items *crossed*
    // the threshold on this sync, instead of re-alerting on every sync.
    const [existing] = await pool.query(
      'SELECT shopify_variant_id, stock_quantity, low_stock_threshold FROM inventory_items WHERE seller_id = ?',
      [req.sellerId]
    );
    const before = new Map(existing.map((row) => [row.shopify_variant_id, row]));
    const crossedLowStock = [];

    for (const product of products) {
      for (const variant of product.variants) {
        // Shopify reports inventory_quantity 0 for variants it doesn't track
        // (gift cards, "don't track quantity" products) — they'd show up as
        // permanently low stock, so leave them out.
        if (!variant.inventory_management) {
          untrackedVariantIds.push(variant.id);
          continue;
        }

        const itemName = `${product.title}${variant.title !== 'Default Title' ? ' - ' + variant.title : ''}`;
        const stock = variant.inventory_quantity || 0;

        await pool.query(
          `INSERT INTO inventory_items
             (seller_id, shopify_product_id, shopify_variant_id, item_name, stock_quantity)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             stock_quantity = VALUES(stock_quantity),
             synced_at = CURRENT_TIMESTAMP`,
          [req.sellerId, product.id, variant.id, itemName, stock]
        );
        count++;

        // Only items we already knew about count as crossing — otherwise the
        // very first sync would fire an alert for everything that starts low.
        const prev = before.get(String(variant.id));
        if (prev && prev.stock_quantity > prev.low_stock_threshold && stock <= prev.low_stock_threshold) {
          crossedLowStock.push({
            item_name: itemName,
            shopify_variant_id: String(variant.id),
            previous_stock: prev.stock_quantity,
            current_stock: stock,
            low_stock_threshold: prev.low_stock_threshold,
          });
        }
      }
    }

    // Clear rows from earlier syncs, or from variants that stopped being tracked.
    if (untrackedVariantIds.length) {
      await pool.query(
        'DELETE FROM inventory_items WHERE seller_id = ? AND shopify_variant_id IN (?)',
        [req.sellerId, untrackedVariantIds.map(String)]
      );
    }

    res.json({
      message: `Synced ${count} inventory items (skipped ${untrackedVariantIds.length} untracked)`,
    });

    // Trigger #2: respond first, then let the agent decide what to do about it.
    if (crossedLowStock.length) {
      triggerAgent(req.sellerId, { type: 'low_stock_crossed', items: crossedLowStock });
    }
  } catch (err) {
    console.error(err.response?.data || err);
    res.status(500).json({ error: 'Could not sync inventory from Shopify' });
  }
}

module.exports = { syncOrders, syncInventory };
