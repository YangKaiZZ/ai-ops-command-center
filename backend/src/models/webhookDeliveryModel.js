const pool = require('../config/db');

// Shopify webhook deliveries already handled, by X-Shopify-Webhook-Id (every
// retry of one delivery carries the same id). Kept in the database so a
// redelivery is still recognised after a restart; the job worker prunes ids
// older than a week (Shopify stops retrying after 48 hours).
async function isHandled(webhookId) {
  const [rows] = await pool.query('SELECT 1 FROM webhook_deliveries WHERE webhook_id = ?', [webhookId]);
  return rows.length > 0;
}

async function markHandled(webhookId, topic) {
  await pool.query('INSERT IGNORE INTO webhook_deliveries (webhook_id, topic) VALUES (?, ?)', [webhookId, topic]);
}

module.exports = { isHandled, markHandled };
