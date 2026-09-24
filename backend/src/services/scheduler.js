const { getConnectedSellerIds } = require('../models/sellerModel');
const { syncOrders, syncInventory } = require('./syncService');

// Webhooks keep data current, but deliveries can be missed (backend down,
// tunnel changed, a topic not registered). This re-syncs every connected
// store on a timer as a safety net. SYNC_INTERVAL_MINUTES=0 turns it off.
const FIRST_RUN_DELAY_MS = 15 * 1000;

function startScheduledSync() {
  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES ?? 15);
  if (!(minutes > 0)) {
    console.log('[sync] scheduled sync is off (SYNC_INTERVAL_MINUTES=0)');
    return;
  }

  let running = false;
  async function runOnce() {
    if (running) return; // a slow run is still going; skip this tick
    running = true;
    try {
      for (const sellerId of await getConnectedSellerIds()) {
        const results = [];
        for (const [label, sync] of [['orders', syncOrders], ['inventory', syncInventory]]) {
          try {
            const { message } = await sync(sellerId);
            results.push(message);
          } catch (err) {
            results.push(`${label} FAILED (${err.response?.status || err.message})`);
          }
        }
        console.log(`[sync] seller ${sellerId}: ${results.join('; ')}`);
      }
    } catch (err) {
      console.error(`[sync] scheduled run failed: ${err.message}`);
    } finally {
      running = false;
    }
  }

  setTimeout(runOnce, FIRST_RUN_DELAY_MS);
  setInterval(runOnce, minutes * 60 * 1000);
  console.log(`[sync] scheduled sync every ${minutes} min`);
}

module.exports = { startScheduledSync };
