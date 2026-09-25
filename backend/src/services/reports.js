const crypto = require('crypto');
const pool = require('../config/db');
const reports = require('../models/reportModel');
const { PENDING_WHERE } = require('../controllers/ordersController');
const { COUNTED, countDecisions, runningOut } = require('../controllers/overviewController');
const { countRatings, RATINGS_SELECT } = require('../models/decisionModel');
const { getForecast } = require('./restockForecast');
const { postDecision } = require('./notifier');
const { dashboardUrl } = require('./ratingLinks');
const { enqueue } = require('./jobQueue');
const { isTimeZone, localParts, localDate, addDays, startOfDay } = require('../utils/timeZone');

// The daily summary (yesterday in numbers, at an hour the seller picks) and
// late-order alerts (paid orders still not shipped after N hours). Both go
// to the seller's alert channels, computed in code: no model call.
//
// A tick every few minutes (startReportScheduler) queues what's due as jobs,
// with keys that make each summary and each alert happen once, however many
// ticks or restarts there are. REPORT_CHECK_MINUTES=0 turns the tick off.

const HOUR_MS = 60 * 60 * 1000;
const MAX_LISTED = 10; // orders named in one late-order alert

const zoneOf = (seller) => (isTimeZone(seller.timezone) ? seller.timezone : 'UTC');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const money = (value) => (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The local date whose summary is due now, or null: due once the seller's
// hour has come, if that day's summary hasn't gone out.
function summaryDue(seller, now = new Date()) {
  const zone = zoneOf(seller);
  const today = localDate(now, zone);
  if (localParts(now, zone).hour < seller.summary_hour) return null;
  if (seller.summary_sent_on && seller.summary_sent_on >= today) return null;
  return today;
}

// "placed 5 hours ago", "placed 3 days ago"
function placedAgo(placedAt, now) {
  const hours = Math.max(0, Math.floor((now - new Date(placedAt)) / HOUR_MS));
  return hours < 48 ? `placed ${plural(hours, 'hour')} ago` : `placed ${Math.floor(hours / 24)} days ago`;
}

// "up 3 on the day before" / "down 1.50" / "the same as the day before"
function versus(current, previous, format = String) {
  const diff = Math.round((current - previous) * 100) / 100;
  if (diff === 0) return 'the same as the day before';
  return `${diff > 0 ? 'up' : 'down'} ${format(Math.abs(diff))} on the day before`;
}

// Everything the summary for the day before `today` (a local date) says.
async function summaryNumbers(sellerId, { zone, today, lateAfterHours, now = new Date() }) {
  const day = addDays(today, -1);
  const seconds = (date) => Math.floor(startOfDay(date, zone).getTime() / 1000);
  const from = seconds(day);
  const to = seconds(today);
  const previousFrom = seconds(addDays(today, -2));

  const [[orders]] = await pool.query(
    `SELECT
       COALESCE(SUM(order_placed_at >= FROM_UNIXTIME(?)), 0) AS count,
       COALESCE(SUM(CASE WHEN order_placed_at >= FROM_UNIXTIME(?) AND ${COUNTED} THEN total_amount END), 0) AS sales,
       COALESCE(SUM(order_placed_at < FROM_UNIXTIME(?)), 0) AS previous_count,
       COALESCE(SUM(CASE WHEN order_placed_at < FROM_UNIXTIME(?) AND ${COUNTED} THEN total_amount END), 0) AS previous_sales
     FROM orders WHERE seller_id = ? AND order_placed_at >= FROM_UNIXTIME(?) AND order_placed_at < FROM_UNIXTIME(?)`,
    [from, from, from, from, sellerId, previousFrom, to]
  );
  const [[{ needsAction }]] = await pool.query(`SELECT COUNT(*) AS needsAction FROM orders WHERE seller_id = ? AND (${PENDING_WHERE})`, [sellerId]);
  const [[oldest]] = await pool.query(
    `SELECT order_number, order_placed_at FROM orders
     WHERE seller_id = ? AND status IN ('unfulfilled', 'partial') AND ${COUNTED}
     ORDER BY order_placed_at, id LIMIT 1`,
    [sellerId]
  );
  const [[{ late }]] = await pool.query(
    `SELECT COUNT(*) AS late FROM orders WHERE seller_id = ? AND ${reports.LATE_WHERE} AND order_placed_at < NOW() - INTERVAL ? HOUR`,
    [sellerId, lateAfterHours]
  );
  const [[stock]] = await pool.query(
    `SELECT COUNT(*) AS tracked, COALESCE(SUM(stock_quantity <= low_stock_threshold), 0) AS low,
       COALESCE(SUM(stock_quantity <= 0), 0) AS out_of_stock
     FROM inventory_items WHERE seller_id = ?`,
    [sellerId]
  );
  const forecast = await getForecast(sellerId, {}, now.getTime());
  const [decisionRows] = await pool.query(
    `${RATINGS_SELECT} WHERE seller_id = ? AND created_at >= FROM_UNIXTIME(?) AND created_at < FROM_UNIXTIME(?) GROUP BY action_taken`,
    [sellerId, from, to]
  );
  const [[{ unrated }]] = await pool.query(
    `SELECT COUNT(*) AS unrated FROM decisions
     WHERE seller_id = ? AND feedback IS NULL AND action_taken <> 'skipped' AND created_at >= NOW() - INTERVAL 7 DAY`,
    [sellerId]
  );

  return {
    day: startOfDay(day, zone),
    zone,
    orders: {
      count: Number(orders.count),
      sales: Number(orders.sales),
      previous_count: Number(orders.previous_count),
      previous_sales: Number(orders.previous_sales),
    },
    needs_action: Number(needsAction),
    oldest_unshipped: oldest || null,
    late: Number(late),
    late_after_hours: lateAfterHours,
    stock: { tracked: Number(stock.tracked), low: Number(stock.low), out_of_stock: Number(stock.out_of_stock) },
    running_out: runningOut(forecast.items).slice(0, 3),
    decisions: countDecisions(decisionRows),
    ratings: countRatings(decisionRows),
    unrated_this_week: Number(unrated),
  };
}

// The summary as a message (Slack *bold*; email and Telegram get it plain).
function formatSummary(n, { businessName, link, now = new Date() }) {
  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: n.zone, weekday: 'short', month: 'short', day: 'numeric' }).format(n.day);
  const lines = [`*Daily summary for ${businessName}: ${dayLabel}*`];

  const o = n.orders;
  lines.push(
    o.count || o.previous_count
      ? `- Orders: ${o.count}, ${versus(o.count, o.previous_count)}. Sales: ${money(o.sales)}, ${versus(o.sales, o.previous_sales, money)}.`
      : '- Orders: none, and none the day before.'
  );
  if (n.needs_action) {
    const oldest = n.oldest_unshipped
      ? ` Oldest unshipped: ${n.oldest_unshipped.order_number ?? 'an order'}, ${placedAgo(n.oldest_unshipped.order_placed_at, now)}.`
      : '';
    lines.push(`- Needs action: ${plural(n.needs_action, 'order')}.${oldest}`);
  } else {
    lines.push('- Needs action: nothing.');
  }
  if (n.late) lines.push(`- Late: ${plural(n.late, 'paid order')} not shipped after ${n.late_after_hours} hours.`);
  if (n.stock.tracked) {
    lines.push(`- Stock: ${n.stock.low} running low${n.stock.out_of_stock ? `, ${n.stock.out_of_stock} out of stock` : ''}.`);
  }
  if (n.running_out.length) {
    const items = n.running_out.map((f) => `${f.item_name} in about ${plural(Math.max(1, Math.round(f.days_left)), 'day')} (reorder ${f.reorder_quantity})`);
    lines.push(`- Runs out this week: ${items.join('; ')}.`);
  }
  const d = n.decisions;
  if (d.total) {
    const verdicts = [
      [d.fulfill, 'fulfill'],
      [d.hold, 'hold'],
      [d.low_stock_alert, 'restock'],
      [d.skipped, 'skipped'],
      [d.unknown, 'unclear'],
    ]
      .filter(([count]) => count)
      .map(([count, label]) => `${count} ${label}`);
    const rated = n.ratings.up + n.ratings.down;
    const accuracy = rated ? ` ${n.ratings.up} of ${rated} rated right.` : '';
    lines.push(`- Agent: ${plural(d.total, 'decision')} (${verdicts.join(', ')}).${accuracy}`);
  } else {
    lines.push('- Agent: no decisions.');
  }
  if (n.unrated_this_week) {
    lines.push(`- ${plural(n.unrated_this_week, 'decision')} from the last 7 days ${n.unrated_this_week === 1 ? "isn't" : "aren't"} rated yet: ${link}/decisions?show=unrated`);
  }
  lines.push(`Dashboard: ${link}/overview`);
  return lines.join('\n');
}

// A late-order alert naming each order (oldest first, the first 10).
function formatLateOrders(orders, { afterHours, link, now = new Date() }) {
  const lines = [`*Late orders: ${plural(orders.length, 'paid order')} not shipped after ${afterHours} hours*`];
  for (const o of orders.slice(0, MAX_LISTED)) {
    lines.push(`- ${o.order_number ?? `Order ${o.id}`}, ${placedAgo(o.order_placed_at, now)}, ${money(o.total_amount)}`);
  }
  if (orders.length > MAX_LISTED) lines.push(`- and ${orders.length - MAX_LISTED} more`);
  lines.push(`Orders that need action: ${link}/orders?needs_action=1`);
  return lines.join('\n');
}

// Builds and sends the summary for the day before `today` (a local date).
// A scheduled one is skipped if it was turned off or already sent since it
// was queued, and marked sent afterwards; a preview (Settings' "Send one
// now") is always sent and changes nothing. Returns the channel results.
async function sendDailySummary(sellerId, { today = null, preview = false } = {}) {
  const seller = await reports.getReportSettings(sellerId);
  if (!seller) return [];
  const zone = zoneOf(seller);
  const now = new Date();
  const day = today || localDate(now, zone);
  if (!preview && (!seller.summary_enabled || (seller.summary_sent_on && seller.summary_sent_on >= day))) return [];

  const numbers = await summaryNumbers(sellerId, { zone, today: day, lateAfterHours: seller.late_after_hours, now });
  const results = await postDecision(sellerId, formatSummary(numbers, { businessName: seller.business_name, link: dashboardUrl(), now }));
  if (!preview) await reports.markSummarySent(sellerId, day);
  return results;
}

// One alert for the orders that turned late since the last one; each order
// is only ever named once.
async function sendLateOrderAlert(sellerId) {
  const seller = await reports.getReportSettings(sellerId);
  if (!seller?.late_alerts_enabled) return [];
  const orders = await reports.lateOrdersToAlert(sellerId, seller.late_after_hours);
  if (!orders.length) return [];
  const results = await postDecision(sellerId, formatLateOrders(orders, { afterHours: seller.late_after_hours, link: dashboardUrl() }));
  await reports.markLateAlerted(sellerId, orders.map((o) => o.id));
  return results;
}

// Queues each report that's due. The keys make it once per summary day, and
// once per set of late orders (a job still waiting isn't queued twice).
async function queueDueReports(now = new Date()) {
  const queued = { summaries: 0, late: 0 };
  for (const seller of await reports.sellersWithReports()) {
    if (seller.summary_enabled) {
      const today = summaryDue(seller, now);
      if (today && (await enqueue('daily_summary', seller.id, { today }, { dedupeKey: `summary:${seller.id}:${today}` }))) queued.summaries++;
    }
    if (seller.late_alerts_enabled) {
      const orders = await reports.lateOrdersToAlert(seller.id, seller.late_after_hours);
      if (orders.length) {
        const ids = crypto.createHash('sha1').update(orders.map((o) => o.id).join(',')).digest('hex');
        if (await enqueue('late_orders', seller.id, {}, { dedupeKey: `late:${seller.id}:${ids}` })) queued.late++;
      }
    }
  }
  return queued;
}

function startReportScheduler() {
  const minutes = Number(process.env.REPORT_CHECK_MINUTES ?? 5);
  if (!(minutes > 0)) {
    console.log('[reports] daily summaries and late-order alerts are off (REPORT_CHECK_MINUTES=0)');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const queued = await queueDueReports();
      if (queued.summaries || queued.late) console.log(`[reports] queued ${queued.summaries} summary(ies), ${queued.late} late-order alert(s)`);
    } catch (err) {
      console.error(`[reports] check failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 30 * 1000);
  setInterval(tick, minutes * 60 * 1000);
  console.log(`[reports] checking for due summaries and late orders every ${minutes} min`);
}

module.exports = {
  summaryDue,
  summaryNumbers,
  formatSummary,
  formatLateOrders,
  sendDailySummary,
  sendLateOrderAlert,
  queueDueReports,
  startReportScheduler,
};
