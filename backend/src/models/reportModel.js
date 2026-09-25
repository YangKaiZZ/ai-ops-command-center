const pool = require('../config/db');

// Settings and state for the daily summary and late-order alerts
// (services/reports.js). Both are off until the seller turns them on.

// A paid (or authorized) order that isn't fully shipped. Pending payments
// aren't late: they can't ship yet.
const LATE_WHERE = `status IN ('unfulfilled', 'partial') AND financial_status IN ('paid', 'authorized', 'partially_refunded')`;
// Only orders that turned late recently are alerted, so switching alerts on
// doesn't bring up the store's whole history. (The summary counts them all.)
const LATE_ALERT_WINDOW_DAYS = 14;

const SETTINGS_COLUMNS = `id, business_name, timezone, summary_enabled, summary_hour,
  DATE_FORMAT(summary_sent_on, '%Y-%m-%d') AS summary_sent_on, late_alerts_enabled, late_after_hours`;

// One seller's report settings, as stored (booleans as 0/1).
async function getReportSettings(sellerId) {
  const [[row]] = await pool.query(`SELECT ${SETTINGS_COLUMNS} FROM sellers WHERE id = ?`, [sellerId]);
  return row || null;
}

// Every seller with a report turned on, for the scheduler.
async function sellersWithReports() {
  const [rows] = await pool.query(`SELECT ${SETTINGS_COLUMNS} FROM sellers WHERE summary_enabled OR late_alerts_enabled`);
  return rows;
}

// Saves what the Settings page sends. `sentOn` (a local date) marks today's
// summary as done, so turning it on after its hour doesn't send one at once.
async function saveReportSettings(sellerId, { timezone, summary, lateOrders }, sentOn = null) {
  await pool.query(
    `UPDATE sellers SET timezone = ?, summary_enabled = ?, summary_hour = ?, late_alerts_enabled = ?, late_after_hours = ?,
       summary_sent_on = CASE WHEN ? IS NULL THEN summary_sent_on ELSE GREATEST(COALESCE(summary_sent_on, ?), ?) END
     WHERE id = ?`,
    [timezone, summary.enabled, summary.hour, lateOrders.enabled, lateOrders.afterHours, sentOn, sentOn, sentOn, sellerId]
  );
}

async function markSummarySent(sellerId, day) {
  await pool.query('UPDATE sellers SET summary_sent_on = ? WHERE id = ?', [day, sellerId]);
}

// Late orders no alert has named yet, oldest first.
async function lateOrdersToAlert(sellerId, afterHours, limit = 50) {
  const [rows] = await pool.query(
    `SELECT id, order_number, total_amount, order_placed_at FROM orders
     WHERE seller_id = ? AND ${LATE_WHERE} AND late_alerted_at IS NULL
       AND order_placed_at < NOW() - INTERVAL ? HOUR
       AND order_placed_at >= NOW() - INTERVAL ? DAY
     ORDER BY order_placed_at, id
     LIMIT ?`,
    [sellerId, afterHours, LATE_ALERT_WINDOW_DAYS, limit]
  );
  return rows;
}

async function markLateAlerted(sellerId, orderIds) {
  if (!orderIds.length) return;
  await pool.query('UPDATE orders SET late_alerted_at = NOW() WHERE seller_id = ? AND id IN (?)', [sellerId, orderIds]);
}

module.exports = {
  LATE_WHERE,
  LATE_ALERT_WINDOW_DAYS,
  getReportSettings,
  sellersWithReports,
  saveReportSettings,
  markSummarySent,
  lateOrdersToAlert,
  markLateAlerted,
};
