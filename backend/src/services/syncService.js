const shopifyService = require('./shopifyService');
const { upsertOrder, ordersMissingLineItems } = require('../models/orderModel');
const { MAX_LOOKBACK_DAYS } = require('./restockForecast');
const { getStoreCredentials, getOrdersSyncedAt, setOrdersSyncedAt, getDefaultThreshold } = require('../models/sellerModel');
const inventory = require('../models/inventoryModel');
const { queueAgentRun } = require('./agentService');
const { refreshRecentRisks } = require('./riskCheck');
const { withLock } = require('../utils/lock');

// Re-ask for orders changed a little before the last sync, in case our clock
// and Shopify's disagree or an update landed while that sync was running.
const ORDER_SYNC_OVERLAP_MS = 10 * 60 * 1000;
const BACKFILL_BATCH = 100; // order ids per Shopify request

class StoreNotConnectedError extends Error {
  constructor() {
    super('Connect your Shopify store first (Settings > Store)');
  }
}

// An item crosses when it goes from above its threshold to at/below it.
// Items we'd never seen don't count, or the very first sync would alert on
// everything that starts low.
function crossedLowStock(prev, stock) {
  return Boolean(prev) && prev.stock_quantity > prev.low_stock_threshold && stock <= prev.low_stock_threshold;
}

async function requireCredentials(sellerId) {
  const creds = await getStoreCredentials(sellerId);
  if (!creds) throw new StoreNotConnectedError();
  return creds;
}

// Manual sync, the scheduled sync and webhooks can all touch the same
// seller's data at once, so each runs under a per-seller lock: that keeps the
// "did this cross the threshold?" check from alerting twice.

// Orders saved before line items were kept have none, so restock forecasts
// would miss what they sold. Fetch the ones from the forecast's longest
// window again, a batch at a time. Returns how many got their items.
// An order deleted in Shopify stays without items and is asked about again
// at the next sync: one small request, only until it leaves the window.
async function backfillLineItems(sellerId, creds) {
  const ids = await ordersMissingLineItems(sellerId, MAX_LOOKBACK_DAYS);
  let filled = 0;
  for (let i = 0; i < ids.length; i += BACKFILL_BATCH) {
    const orders = await shopifyService.fetchOrdersByIds(creds.shopDomain, creds.accessToken, ids.slice(i, i + BACKFILL_BATCH));
    for (const order of orders) await upsertOrder(sellerId, order);
    filled += orders.length;
  }
  return filled;
}

// Pulls orders into our table. The first sync takes everything; after that
// only orders created or updated since the last one.
function syncOrders(sellerId) {
  return withLock(`orders:${sellerId}`, async () => {
    const creds = await requireCredentials(sellerId);
    const startedAt = new Date();
    const lastSync = await getOrdersSyncedAt(sellerId);
    const updatedAtMin = lastSync ? new Date(new Date(lastSync).getTime() - ORDER_SYNC_OVERLAP_MS) : null;

    const orders = await shopifyService.fetchOrders(creds.shopDomain, creds.accessToken, { updatedAtMin });
    for (const order of orders) await upsertOrder(sellerId, order);
    await setOrdersSyncedAt(sellerId, startedAt);

    // The sync itself has worked by now, so a failure here is only logged;
    // the next sync tries again.
    let filled = 0;
    try {
      filled = await backfillLineItems(sellerId, creds);
    } catch (err) {
      console.warn(`[sync seller=${sellerId}] fetching older orders' items failed: ${err.response?.status || err.message}`);
    }

    // Fraud assessments can come in after the order: read them again for
    // recent open orders (riskCheck.js). Only logged when it fails, like the above.
    try {
      const risks = await refreshRecentRisks(sellerId, creds);
      if (risks.alerted) console.log(`[sync seller=${sellerId}] fraud risk went up on ${risks.alerted} order(s); the seller was alerted`);
    } catch (err) {
      console.warn(`[sync seller=${sellerId}] re-reading fraud risk failed: ${err.response?.status || err.message}`);
    }

    const synced = updatedAtMin ? `Synced ${orders.length} new or updated orders` : `Synced ${orders.length} orders`;
    return {
      count: orders.length,
      message: filled ? `${synced} (and fetched the items of ${filled} older ones)` : synced,
    };
  });
}

// Pulls every product + variant, flattens tracked variants into inventory
// rows, and alerts the agent about items that just went low.
function syncInventory(sellerId) {
  return withLock(`inventory:${sellerId}`, async () => {
    const creds = await requireCredentials(sellerId);
    const products = await shopifyService.fetchProducts(creds.shopDomain, creds.accessToken);
    const before = await inventory.getStockSnapshot(sellerId);
    const defaultThreshold = await getDefaultThreshold(sellerId);
    const trackedVariantIds = [];
    const crossed = [];
    let untracked = 0;

    for (const product of products) {
      for (const variant of product.variants) {
        // Shopify reports inventory_quantity 0 for variants it doesn't track
        // (gift cards, "don't track quantity" products) — they'd show up as
        // permanently low stock, so leave them out.
        if (!variant.inventory_management) {
          untracked++;
          continue;
        }

        const item = {
          productId: String(product.id),
          variantId: String(variant.id),
          inventoryItemId: variant.inventory_item_id != null ? String(variant.inventory_item_id) : null,
          itemName: `${product.title}${variant.title !== 'Default Title' ? ' - ' + variant.title : ''}`,
          stock: variant.inventory_quantity || 0,
        };
        await inventory.upsertInventoryItem(sellerId, item, defaultThreshold);
        trackedVariantIds.push(item.variantId);

        const prev = before.get(item.variantId);
        if (crossedLowStock(prev, item.stock)) {
          crossed.push({
            item_name: item.itemName,
            shopify_variant_id: item.variantId,
            previous_stock: prev.stock_quantity,
            current_stock: item.stock,
            low_stock_threshold: prev.low_stock_threshold,
          });
        }
      }
    }

    // The product list was complete (every page), so anything else is gone.
    await inventory.deleteInventoryExcept(sellerId, trackedVariantIds);

    if (crossed.length) await queueAgentRun(sellerId, { type: 'low_stock_crossed', items: crossed });

    return {
      count: trackedVariantIds.length,
      crossed: crossed.length,
      message: `Synced ${trackedVariantIds.length} inventory items (skipped ${untracked} untracked)`,
    };
  });
}

// One inventory item's stock changed in Shopify (inventory_levels/update
// webhook). The webhook only has one location's count, so re-read the
// variant for the total across locations.
function refreshInventoryItem(sellerId, inventoryItemId) {
  return withLock(`inventory:${sellerId}`, async () => {
    const row = await inventory.findByInventoryItemId(sellerId, inventoryItemId);
    if (!row) return { status: 'unknown item' }; // new product: the next full sync adds it

    const creds = await requireCredentials(sellerId);
    const variant = await shopifyService.fetchVariant(creds.shopDomain, creds.accessToken, row.shopify_variant_id);
    if (!variant || !variant.inventory_management) {
      await inventory.deleteInventoryItem(row.id);
      return { status: 'removed' };
    }

    const stock = variant.inventory_quantity || 0;
    await inventory.updateStock(row.id, stock);
    if (crossedLowStock(row, stock)) {
      await queueAgentRun(sellerId, {
        type: 'low_stock_crossed',
        items: [
          {
            item_name: row.item_name,
            shopify_variant_id: row.shopify_variant_id,
            previous_stock: row.stock_quantity,
            current_stock: stock,
            low_stock_threshold: row.low_stock_threshold,
          },
        ],
      });
      return { status: 'updated', stock, crossed: true };
    }
    return { status: 'updated', stock, crossed: false };
  });
}

module.exports = {
  syncOrders,
  syncInventory,
  refreshInventoryItem,
  crossedLowStock,
  StoreNotConnectedError,
};
