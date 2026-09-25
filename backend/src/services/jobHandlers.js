const { registerHandler } = require('./jobQueue');
const { runAgent } = require('./agentService');
const { refreshInventoryItem } = require('./syncService');
const { sendDailySummary, sendLateOrderAlert } = require('./reports');

// What each kind of job does. server.js loads this before starting the worker.

// An agent run for a new order or items that went low (queueAgentRun).
registerHandler('agent_run', (job) => runAgent(job.sellerId, job.payload.trigger));

// An inventory_levels/update webhook: re-read that variant's total stock. An
// item that just went low queues an agent run of its own.
registerHandler('refresh_inventory_item', async (job) => {
  const { inventoryItemId } = job.payload;
  const result = await refreshInventoryItem(job.sellerId, inventoryItemId);
  console.log(
    `[job ${job.id}] inventory item ${inventoryItemId} seller=${job.sellerId}: ${result.status}${result.stock != null ? `, stock ${result.stock}` : ''}`
  );
});

// A daily summary that came due (reports.queueDueReports); `today` is the
// seller's local date, and the summary covers the day before it.
registerHandler('daily_summary', (job) => sendDailySummary(job.sellerId, { today: job.payload.today }));

// Paid orders that turned late since the last alert.
registerHandler('late_orders', (job) => sendLateOrderAlert(job.sellerId));
