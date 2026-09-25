const pool = require('../config/db');

// Restock forecasts from the orders we've stored: how fast each tracked item
// sells, when it runs out at that pace, and how many to reorder to cover the
// next few weeks. Worked out in code, not by the model, so the dashboard,
// Slack and Claude Desktop all see the same numbers.
//
// Every forecast says how much history it's based on. A pace worked out from
// three orders in four days is a rough guess, and the seller should know that.

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 90; // the order sync fetches older orders' items this far back
const DEFAULT_COVER_DAYS = 30;
const MAX_COVER_DAYS = 180;
// Fewer orders or days than this, and a forecast is marked low confidence.
const MIN_ORDERS = 3;
const MIN_HISTORY_DAYS = 7;

// Refunded and voided orders didn't really sell anything.
const COUNTED_ORDER = "COALESCE(o.financial_status, '') NOT IN ('refunded', 'voided')";

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

function parseDays(value, name, max, fallback) {
  if (value === undefined) return { value: fallback };
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > max) {
    return { error: `${name} must be a whole number of days from 1 to ${max}` };
  }
  return { value: Number(value) };
}

// ?days= (how far back to look at sales) and ?cover_days= (how long a
// reorder should last). Returns { error } for bad input.
function parseForecastQuery(query = {}) {
  const lookback = parseDays(query.days, 'days', MAX_LOOKBACK_DAYS, DEFAULT_LOOKBACK_DAYS);
  if (lookback.error) return lookback;
  const cover = parseDays(query.cover_days, 'cover_days', MAX_COVER_DAYS, DEFAULT_COVER_DAYS);
  if (cover.error) return cover;
  return { lookbackDays: lookback.value, coverDays: cover.value };
}

// The stretch of time the sales are counted over: the last `lookbackDays`,
// or less when the store's first order is more recent than that. `from` is
// null when there are no orders at all.
function historyWindow(firstOrderMs, nowMs, lookbackDays) {
  if (firstOrderMs == null) return { fromMs: null, days: 0 };
  const fromMs = Math.min(nowMs, Math.max(nowMs - lookbackDays * DAY_MS, firstOrderMs));
  return { fromMs, days: (nowMs - fromMs) / DAY_MS };
}

// One item's forecast.
//   stock: what's left in Shopify (below zero: sold more than it has)
//   sold: { units, orders } for this item over the history, or undefined
//   historyDays: how many days those sales came from
function forecastItem(stock, sold, { historyDays, coverDays, nowMs }) {
  const units = sold?.units ?? 0;
  const orders = sold?.orders ?? 0;
  // At least a day, so an order an hour ago doesn't read as 24 a day.
  const perDay = units / Math.max(historyDays, 1);

  let daysLeft = null; // null: it isn't selling, so no run-out date
  if (stock <= 0) daysLeft = 0;
  else if (perDay > 0) daysLeft = stock / perDay;

  // Enough to sell for coverDays at this pace, on top of what's in stock.
  // Negative stock is units already sold, so they're added. (The small
  // subtraction keeps float noise like 40.0000001 from rounding up to 41.)
  const reorder = Math.max(0, Math.ceil(perDay * coverDays - stock - 1e-9));

  return {
    units_sold: units,
    orders,
    per_day: round(perDay, 2),
    days_left: daysLeft === null ? null : round(daysLeft, 1),
    runs_out_at: daysLeft > 0 ? new Date(nowMs + daysLeft * DAY_MS).toISOString() : null,
    reorder_quantity: reorder,
    confidence: orders < MIN_ORDERS || historyDays < MIN_HISTORY_DAYS ? 'low' : 'normal',
  };
}

// Soonest to run out first; items that aren't selling last.
function byUrgency(a, b) {
  if (a.days_left !== b.days_left) {
    if (a.days_left === null) return 1;
    if (b.days_left === null) return -1;
    return a.days_left - b.days_left;
  }
  return b.reorder_quantity - a.reorder_quantity || a.item_name.localeCompare(b.item_name);
}

// Forecasts for every tracked item (or only `variantIds`), with the history
// they're based on:
//   history.from / days: the stretch of orders counted
//   history.orders: orders counted (refunded and voided ones aren't)
//   history.orders_missing_items: orders in that stretch whose items we don't
//     have yet, so their sales are missing (the next order sync fetches them)
async function getForecast(sellerId, { lookbackDays = DEFAULT_LOOKBACK_DAYS, coverDays = DEFAULT_COVER_DAYS, variantIds } = {}, nowMs = Date.now()) {
  const onlySome = Array.isArray(variantIds);
  const [items] =
    onlySome && !variantIds.length
      ? [[]]
      : await pool.query(
          `SELECT id, item_name, shopify_variant_id, stock_quantity, low_stock_threshold FROM inventory_items
           WHERE seller_id = ?${onlySome ? ' AND shopify_variant_id IN (?)' : ''}`,
          onlySome ? [sellerId, variantIds.map(String)] : [sellerId]
        );

  const [[{ first }]] = await pool.query('SELECT UNIX_TIMESTAMP(MIN(order_placed_at)) AS first FROM orders WHERE seller_id = ?', [
    sellerId,
  ]);
  const window = historyWindow(first == null ? null : Number(first) * 1000, nowMs, lookbackDays);

  let counted = 0;
  let missing = 0;
  const sales = new Map();
  if (window.fromMs != null) {
    // FROM_UNIXTIME keeps the comparison on the (seller_id, order_placed_at) index.
    const from = Math.floor(window.fromMs / 1000);
    const [[totals]] = await pool.query(
      `SELECT SUM(o.line_items_synced_at IS NOT NULL) AS counted, SUM(o.line_items_synced_at IS NULL) AS missing
       FROM orders o WHERE o.seller_id = ? AND o.order_placed_at >= FROM_UNIXTIME(?) AND ${COUNTED_ORDER}`,
      [sellerId, from]
    );
    counted = Number(totals.counted) || 0;
    missing = Number(totals.missing) || 0;

    const [rows] = await pool.query(
      `SELECT li.shopify_variant_id AS variant_id, SUM(li.quantity) AS units, COUNT(DISTINCT o.id) AS orders
       FROM order_line_items li JOIN orders o ON o.id = li.order_id
       WHERE o.seller_id = ? AND o.order_placed_at >= FROM_UNIXTIME(?) AND ${COUNTED_ORDER}
         AND li.shopify_variant_id IS NOT NULL
       GROUP BY li.shopify_variant_id`,
      [sellerId, from]
    );
    for (const row of rows) sales.set(row.variant_id, { units: Number(row.units), orders: Number(row.orders) });
  }

  const options = { historyDays: window.days, coverDays, nowMs };
  return {
    lookback_days: lookbackDays,
    cover_days: coverDays,
    history: {
      from: window.fromMs == null ? null : new Date(window.fromMs).toISOString(),
      days: round(window.days, 1),
      orders: counted,
      orders_missing_items: missing,
    },
    items: items
      .map((item) => ({ ...item, ...forecastItem(Number(item.stock_quantity) || 0, sales.get(item.shopify_variant_id), options) }))
      .sort(byUrgency),
  };
}

module.exports = {
  getForecast,
  forecastItem,
  historyWindow,
  parseForecastQuery,
  byUrgency,
  MAX_LOOKBACK_DAYS,
  MIN_ORDERS,
  MIN_HISTORY_DAYS,
};
