const pool = require('../config/db');
const { PENDING_WHERE } = require('./ordersController');
const { getForecast } = require('../services/restockForecast');

// The dashboard's Overview: the key numbers for a period (by default the last
// 7 days) next to the same length of time just before it. Everything is
// counted from our own tables; nothing here is estimated except the restock
// forecasts, which say what they're based on.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PERIOD_DAYS = 7;
const MAX_PERIOD_DAYS = 31;
const RUNNING_OUT_DAYS = 7; // "runs out soon" means within this many days
const ACTIONS = ['fulfill', 'hold', 'low_stock_alert', 'unknown', 'skipped'];

// Sales leave out refunded and voided orders, like the restock forecasts.
const COUNTED = "COALESCE(financial_status, '') NOT IN ('refunded', 'voided')";

// ?from= is when the period starts, an ISO date-time (the dashboard sends the
// seller's local midnight 6 days ago, so "last 7 days" includes today). It may
// be at most 31 days back and not in the future. Returns { fromMs } or { error }.
function parseOverviewQuery(query = {}, nowMs = Date.now()) {
  if (query.from === undefined) return { fromMs: nowMs - DEFAULT_PERIOD_DAYS * DAY_MS };
  const value = query.from;
  const ms = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && value.length <= 40 ? Date.parse(value) : NaN;
  if (Number.isNaN(ms) || ms > nowMs || ms < nowMs - MAX_PERIOD_DAYS * DAY_MS) {
    return { error: `from must be a date-time within the last ${MAX_PERIOD_DAYS} days, like 2026-09-20T00:00:00Z` };
  }
  return { fromMs: ms };
}

const money = (value) => (Number(value) || 0).toFixed(2);

// Decision counts by verdict, every verdict present (0 when none).
function countDecisions(rows) {
  const counts = Object.fromEntries(ACTIONS.map((action) => [action, 0]));
  for (const { action_taken, n } of rows) counts[ACTIONS.includes(action_taken) ? action_taken : 'unknown'] += Number(n);
  return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

// Forecast items that still have stock but run out within `days`, soonest first.
function runningOut(items, days = RUNNING_OUT_DAYS) {
  return items
    .filter((f) => f.days_left != null && f.days_left > 0 && f.days_left <= days)
    .map(({ id, item_name, stock_quantity, units_sold, orders, per_day, days_left, runs_out_at, reorder_quantity, confidence }) => ({
      id,
      item_name,
      stock_quantity,
      units_sold,
      orders,
      per_day,
      days_left,
      runs_out_at,
      reorder_quantity,
      confidence,
    }));
}

// GET /api/overview?from=2026-09-20T00:00:00Z
async function getOverview(req, res) {
  const nowMs = Date.now();
  const parsed = parseOverviewQuery(req.query, nowMs);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const from = Math.floor(parsed.fromMs / 1000);
  const previousFrom = from - Math.ceil((nowMs - parsed.fromMs) / 1000);
  const seller = req.sellerId;
  try {
    // One pass over both periods. FROM_UNIXTIME keeps it on the (seller_id, order_placed_at) index.
    const [[orders]] = await pool.query(
      `SELECT
         COALESCE(SUM(order_placed_at >= FROM_UNIXTIME(?)), 0) AS count,
         COALESCE(SUM(CASE WHEN order_placed_at >= FROM_UNIXTIME(?) AND ${COUNTED} THEN total_amount END), 0) AS sales,
         COALESCE(SUM(order_placed_at < FROM_UNIXTIME(?)), 0) AS previous_count,
         COALESCE(SUM(CASE WHEN order_placed_at < FROM_UNIXTIME(?) AND ${COUNTED} THEN total_amount END), 0) AS previous_sales
       FROM orders WHERE seller_id = ? AND order_placed_at >= FROM_UNIXTIME(?)`,
      [from, from, from, from, seller, previousFrom]
    );
    const [[{ needsAction }]] = await pool.query(`SELECT COUNT(*) AS needsAction FROM orders WHERE seller_id = ? AND (${PENDING_WHERE})`, [
      seller,
    ]);
    const [[oldest]] = await pool.query(
      `SELECT id, order_number, order_placed_at FROM orders
       WHERE seller_id = ? AND status IN ('unfulfilled', 'partial') AND ${COUNTED}
       ORDER BY order_placed_at, id LIMIT 1`,
      [seller]
    );
    const [[stock]] = await pool.query(
      `SELECT COUNT(*) AS tracked, COALESCE(SUM(stock_quantity <= low_stock_threshold), 0) AS low,
         COALESCE(SUM(stock_quantity <= 0), 0) AS out_of_stock
       FROM inventory_items WHERE seller_id = ?`,
      [seller]
    );
    const forecast = await getForecast(seller, {}, nowMs);
    const [decisionRows] = await pool.query(
      `SELECT action_taken, COUNT(*) AS n FROM decisions
       WHERE seller_id = ? AND created_at >= FROM_UNIXTIME(?) GROUP BY action_taken`,
      [seller, from]
    );

    res.json({
      period: {
        from: new Date(parsed.fromMs).toISOString(),
        to: new Date(nowMs).toISOString(),
        days: Math.round(((nowMs - parsed.fromMs) / DAY_MS) * 10) / 10,
      },
      orders: {
        count: Number(orders.count),
        previous_count: Number(orders.previous_count),
        sales: money(orders.sales),
        previous_sales: money(orders.previous_sales),
        needs_action: Number(needsAction),
        oldest_unshipped: oldest || null,
      },
      stock: {
        tracked: Number(stock.tracked),
        low: Number(stock.low),
        out_of_stock: Number(stock.out_of_stock),
        to_reorder: forecast.items.filter((f) => f.reorder_quantity > 0).length,
        running_out_within_days: RUNNING_OUT_DAYS,
        running_out: runningOut(forecast.items),
        forecast: { lookback_days: forecast.lookback_days, cover_days: forecast.cover_days, history: forecast.history },
      },
      decisions: countDecisions(decisionRows),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the overview' });
  }
}

module.exports = { getOverview, parseOverviewQuery, countDecisions, runningOut };
