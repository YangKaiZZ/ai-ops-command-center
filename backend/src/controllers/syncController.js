const syncService = require('../services/syncService');

// Wraps a sync for an HTTP route. The same syncs also run on a schedule
// (services/scheduler.js), so the logic lives in syncService.
function syncRoute(run, failureMessage) {
  return async (req, res) => {
    try {
      const { message } = await run(req.sellerId);
      res.json({ message });
    } catch (err) {
      if (err instanceof syncService.StoreNotConnectedError) {
        return res.status(400).json({ error: err.message });
      }
      console.error(err.response?.data || err);
      res.status(500).json({ error: failureMessage });
    }
  };
}

// POST /api/orders/sync
// Pulls new and updated orders from Shopify into our orders table.
const syncOrders = syncRoute(syncService.syncOrders, 'Could not sync orders from Shopify');

// POST /api/inventory/sync
// Pulls products + variants from Shopify, flattens variants into inventory rows.
// Items that just went low trigger the agent (after the response).
const syncInventory = syncRoute(syncService.syncInventory, 'Could not sync inventory from Shopify');

module.exports = { syncOrders, syncInventory };
