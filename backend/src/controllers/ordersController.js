const pool = require('../config/db');
const orderModel = require('../models/orderModel');
const sellerModel = require('../models/sellerModel');
const shopifyService = require('../services/shopifyService');

const FULFILLMENT_STATUSES = ['unfulfilled', 'partial', 'fulfilled', 'restocked'];
const FINANCIAL_STATUSES = ['pending', 'authorized', 'partially_paid', 'paid', 'partially_refunded', 'refunded', 'voided', 'expired'];
const MAX_LIMIT = 200;
const COLUMNS = 'id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at, synced_at';

// "Needs action": not yet (fully) shipped, or not yet paid; refunded/voided orders are dead.
const PENDING_WHERE = `(status IN ('unfulfilled', 'partial')
    OR financial_status IN ('pending', 'authorized', 'partially_paid'))
  AND COALESCE(financial_status, '') NOT IN ('refunded', 'voided')`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A date (YYYY-MM-DD, a whole UTC day) or an ISO date-time, as epoch seconds.
// For `to`, a bare date means the end of that day.
function parseInstant(value, name, endOfDay) {
  if (typeof value !== 'string' || value.length > 40) return { error: `${name} must be a date like 2026-09-25` };
  const isDay = DAY.test(value);
  const ms = Date.parse(isDay ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(ms) || (!isDay && !/^\d{4}-\d{2}-\d{2}T/.test(value))) {
    return { error: `${name} must be a date like 2026-09-25` };
  }
  return { seconds: Math.floor(ms / 1000) + (isDay && endOfDay ? 86400 - 1 : 0) };
}

function parseWhole(value, name, min, max, fallback) {
  if (value === undefined) return { value: fallback };
  if (typeof value !== 'string' || !/^\d{1,7}$/.test(value) || Number(value) < min || Number(value) > max) {
    return { error: `${name} must be a whole number from ${min} to ${max}` };
  }
  return { value: Number(value) };
}

// Turns the query string into SQL conditions. Returns { error } for bad input,
// so a caller (often a model through the MCP server) is told what to fix.
function parseOrderQuery(query = {}, { defaultLimit = 50, filters = true } = {}) {
  const limit = parseWhole(query.limit, 'limit', 1, MAX_LIMIT, defaultLimit);
  if (limit.error) return limit;
  const offset = parseWhole(query.offset, 'offset', 0, 1000000, 0);
  if (offset.error) return offset;

  const where = [];
  const params = [];
  if (filters) {
    if (query.status !== undefined) {
      if (!FULFILLMENT_STATUSES.includes(query.status)) return { error: `status must be one of: ${FULFILLMENT_STATUSES.join(', ')}` };
      where.push('status = ?');
      params.push(query.status);
    }
    if (query.financial_status !== undefined) {
      if (!FINANCIAL_STATUSES.includes(query.financial_status)) {
        return { error: `financial_status must be one of: ${FINANCIAL_STATUSES.join(', ')}` };
      }
      where.push('financial_status = ?');
      params.push(query.financial_status);
    }
    let from;
    let to;
    if (query.from !== undefined) {
      from = parseInstant(query.from, 'from', false);
      if (from.error) return from;
      // UNIX_TIMESTAMP reads the stored instant, whatever the connection's time zone.
      where.push('UNIX_TIMESTAMP(order_placed_at) >= ?');
      params.push(from.seconds);
    }
    if (query.to !== undefined) {
      to = parseInstant(query.to, 'to', true);
      if (to.error) return to;
      where.push('UNIX_TIMESTAMP(order_placed_at) <= ?');
      params.push(to.seconds);
    }
    if (from && to && from.seconds > to.seconds) return { error: 'from must not be after to' };
    if (query.number !== undefined) {
      const number = typeof query.number === 'string' ? query.number.trim().replace(/^#/, '') : '';
      if (!number || number.length > 50) return { error: 'number must be an order number like #1001' };
      where.push('order_number IN (?, ?)');
      params.push(`#${number}`, number);
    }
    if (query.q !== undefined) {
      const q = typeof query.q === 'string' ? query.q.trim() : null;
      if (q === null || q.length > 100) return { error: 'q must be text of at most 100 characters' };
      if (q) {
        // Part of an order number or customer name; % and _ are searched for literally.
        const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        where.push('(order_number LIKE ? OR buyer_name LIKE ?)');
        params.push(pattern, pattern);
      }
    }
    if (query.needs_action !== undefined) {
      if (!['true', 'false'].includes(query.needs_action)) return { error: 'needs_action must be true or false' };
      if (query.needs_action === 'true') where.push(`(${PENDING_WHERE})`);
    }
  }
  return { limit: limit.value, offset: offset.value, where, params };
}

// Each order's most recent agent decision, or null.
async function attachLatestDecisions(sellerId, orders) {
  if (!orders.length) return orders;
  const [rows] = await pool.query(
    `SELECT order_id, action_taken, reasoning, created_at FROM decisions
     WHERE seller_id = ? AND order_id IN (?) ORDER BY created_at DESC, id DESC`,
    [sellerId, orders.map((o) => o.id)]
  );
  const latest = new Map();
  for (const { order_id, ...decision } of rows) if (!latest.has(order_id)) latest.set(order_id, decision);
  return orders.map((order) => ({ ...order, latest_decision: latest.get(order.id) ?? null }));
}

async function pageOfOrders(sellerId, parsed, extraWhere, orderBy) {
  const where = ['seller_id = ?', ...(extraWhere ? [extraWhere] : []), ...parsed.where].join(' AND ');
  const params = [sellerId, ...parsed.params];
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM orders WHERE ${where}`, params);
  const [rows] = await pool.query(`SELECT ${COLUMNS} FROM orders WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [
    ...params,
    parsed.limit,
    parsed.offset,
  ]);
  return { orders: rows, total: Number(total) };
}

// GET /api/orders?limit=50&offset=0&status=&financial_status=&from=&to=&number=&q=&needs_action=
// This seller's orders, newest first, a page at a time, each with the agent's
// latest decision. `total` counts every order matching the filters.
async function getOrders(req, res) {
  const parsed = parseOrderQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const { orders, total } = await pageOfOrders(req.sellerId, parsed, null, 'order_placed_at DESC, id DESC');
    res.json({ orders: await attachLatestDecisions(req.sellerId, orders), total, limit: parsed.limit, offset: parsed.offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch orders' });
  }
}

// GET /api/orders/pending?limit=50&offset=0
// Orders that need action, oldest (most urgent) first. `total` counts all of them.
async function getPendingOrders(req, res) {
  const parsed = parseOrderQuery(req.query, { filters: false });
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const { orders, total } = await pageOfOrders(req.sellerId, parsed, PENDING_WHERE, 'order_placed_at ASC, id ASC');
    res.json({ pending_orders: orders, total, limit: parsed.limit, offset: parsed.offset });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch pending orders' });
  }
}

// The order's page in the Shopify admin (the myshopify.com address redirects there).
function shopifyAdminUrl(shopDomain, shopifyOrderId) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain || '') || !/^\d+$/.test(shopifyOrderId || '')) return null;
  return `https://${shopDomain}/admin/orders/${shopifyOrderId}`;
}

// Orders synced before line items were stored get them from Shopify, once.
// Returns a note for the seller when that isn't possible, or null.
async function backfillLineItems(sellerId, order) {
  try {
    const creds = await sellerModel.getStoreCredentials(sellerId);
    if (!creds) return 'Connect your store to see what was in this order.';
    const shopifyOrder = await shopifyService.fetchOrder(creds.shopDomain, creds.accessToken, order.shopify_order_id);
    if (!shopifyOrder) return "Shopify no longer has this order, so its items can't be shown.";
    await orderModel.upsertOrder(sellerId, shopifyOrder);
    return null;
  } catch (err) {
    console.error(`[orders] line items for order ${order.id} (seller ${sellerId}): ${err.message}`);
    return "Couldn't load this order's items from Shopify just now. Try again in a minute.";
  }
}

// GET /api/orders/:id
// One order with its line items, every agent decision about it (newest
// first) and a link to it in the Shopify admin.
async function getOrder(req, res) {
  const id = Number(req.params.id);
  const findOrder = async () =>
    (await pool.query(`SELECT ${COLUMNS}, line_items_synced_at FROM orders WHERE id = ? AND seller_id = ?`, [id, req.sellerId]))[0][0];
  try {
    let order = await findOrder();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    let lineItemsNote = null;
    if (!order.line_items_synced_at) {
      lineItemsNote = await backfillLineItems(req.sellerId, order);
      if (!lineItemsNote) order = await findOrder(); // statuses may have changed too
    }

    const [items] = await pool.query(
      `SELECT shopify_line_item_id, shopify_variant_id, title, variant_title, sku, quantity, fulfillable_quantity, price
       FROM order_line_items WHERE order_id = ? ORDER BY id`,
      [id]
    );
    const [decisions] = await pool.query(
      `SELECT id, action_taken, reasoning, created_at FROM decisions
       WHERE seller_id = ? AND order_id = ? ORDER BY created_at DESC, id DESC`,
      [req.sellerId, id]
    );
    const [[seller]] = await pool.query('SELECT shopify_shop_domain FROM sellers WHERE id = ?', [req.sellerId]);

    const { line_items_synced_at, ...fields } = order;
    res.json({
      order: fields,
      line_items: line_items_synced_at ? items : null,
      line_items_note: line_items_synced_at ? null : lineItemsNote,
      decisions,
      shopify_admin_url: shopifyAdminUrl(seller?.shopify_shop_domain, order.shopify_order_id),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch the order' });
  }
}

module.exports = { getOrders, getPendingOrders, getOrder, parseOrderQuery, shopifyAdminUrl, FULFILLMENT_STATUSES, FINANCIAL_STATUSES };
