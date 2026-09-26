const pool = require('../config/db');
const sellerModel = require('../models/sellerModel');
const orderModel = require('../models/orderModel');
const shopifyService = require('./shopifyService');
const oauth = require('./shopifyOAuth');

// Holding, releasing and fulfilling orders in Shopify from here: the buttons
// on an order's page (the seller), and the agent's HOLD when the seller
// turned auto-hold on. Shopify ships an order through its fulfillment orders
// (one per location it ships from); each action is on one of them, and
// Shopify says which actions each allows right now (supportedActions).
//
// Only holds this app placed are released: another app's hold (or Shopify
// Flow's) is theirs to lift. The agent only ever holds, never fulfills.
// Every attempt is logged in order_actions with what Shopify answered.

const HOLD_HANDLE = 'ai-ops'; // marks this app's holds in Shopify
const HOLD_REASONS = {
  HIGH_RISK_OF_FRAUD: 'high risk of fraud',
  INVENTORY_OUT_OF_STOCK: 'out of stock',
  AWAITING_PAYMENT: 'awaiting payment',
  INCORRECT_ADDRESS: 'incorrect address',
  OTHER: 'other',
};
const MAX_NOTE = 255;
const MISSING_PERMISSION =
  "Your store hasn't allowed holding and fulfilling orders from here yet. Reconnect it in Settings > Store to allow it.";

// A refusal the seller can act on, with the HTTP status to answer with.
class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function findOrder(sellerId, orderId) {
  const [[order]] = await pool.query('SELECT id, shopify_order_id, order_number FROM orders WHERE id = ? AND seller_id = ?', [
    orderId,
    sellerId,
  ]);
  if (!order) throw new ActionError('Order not found', 404);
  return order;
}

// The store's credentials, or an ActionError saying what to do first.
async function storeFor(sellerId) {
  const creds = await sellerModel.getStoreCredentials(sellerId);
  if (!creds) throw new ActionError('Connect your Shopify store first (Settings > Store).', 409);
  const [[seller]] = await pool.query('SELECT shopify_scopes FROM sellers WHERE id = ?', [sellerId]);
  if (oauth.actionsAllowed(seller?.shopify_scopes) === false) throw new ActionError(MISSING_PERMISSION, 409);
  return creds;
}

// Shopify's fulfillment orders for an order, with its errors turned into
// ones the seller can act on.
async function fulfillmentOrdersOf(creds, order) {
  let found;
  try {
    found = await shopifyService.fetchFulfillmentOrders(creds.shopDomain, creds.accessToken, order.shopify_order_id);
  } catch (err) {
    if (err.accessDenied) throw new ActionError(MISSING_PERMISSION, 409);
    console.warn(`[actions] order ${order.id}: reading fulfillment orders failed: ${err.response?.status || err.message}`);
    throw new ActionError("Couldn't reach Shopify just now. Try again in a minute.", 502);
  }
  if (!found) throw new ActionError('Shopify no longer has this order.', 404);
  return found;
}

// One fulfillment order as the dashboard shows it, with what can be done now.
function describeFulfillmentOrder(fo) {
  const actions = new Set((fo.supportedActions || []).map((a) => a.action));
  const ours = fo.fulfillmentHolds.some((hold) => hold.heldByRequestingApp);
  return {
    id: fo.id,
    status: String(fo.status).toLowerCase(), // open, scheduled, on_hold, in_progress, closed, cancelled, incomplete
    location: fo.assignedLocation?.name ?? null,
    holds: fo.fulfillmentHolds.map((hold) => ({
      reason: hold.reason,
      label: hold.displayReason,
      note: hold.reasonNotes ?? null,
      ours: hold.heldByRequestingApp,
    })),
    items: fo.lineItems.nodes.map((item) => ({
      title: item.lineItem.title,
      variant_title: item.lineItem.variantTitle ?? null,
      sku: item.lineItem.sku ?? null,
      quantity: item.totalQuantity,
      remaining: item.remainingQuantity,
    })),
    can_hold: actions.has('HOLD') && !ours,
    can_release: actions.has('RELEASE_HOLD') && ours,
    can_fulfill: actions.has('CREATE_FULFILLMENT'),
  };
}

async function logAction(sellerId, orderId, { action, source, fulfillmentOrderId = null, reason = null, note = null, error = null }) {
  await pool.query(
    `INSERT INTO order_actions (seller_id, order_id, action, source, fulfillment_order_id, reason, note, ok, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sellerId, orderId, action, source, fulfillmentOrderId, reason, note ? note.slice(0, MAX_NOTE) : null, !error, error ? error.slice(0, 500) : null]
  );
}

// What was done to an order from here, newest first.
async function actionLog(orderId) {
  const [rows] = await pool.query(
    `SELECT action, source, fulfillment_order_id, reason, note, ok, error, created_at FROM order_actions
     WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 20`,
    [orderId]
  );
  return rows.map((row) => ({ ...row, ok: Boolean(row.ok) }));
}

// GET /api/orders/:id/shopify: the order's fulfillment orders live from
// Shopify, whether actions are allowed (and if not, `note` says why), and
// what was done from here.
async function orderState(sellerId, orderId) {
  const order = await findOrder(sellerId, orderId);
  const actions = await actionLog(order.id);
  try {
    const creds = await storeFor(sellerId);
    const fulfillmentOrders = (await fulfillmentOrdersOf(creds, order)).map(describeFulfillmentOrder);
    return { allowed: true, note: null, fulfillment_orders: fulfillmentOrders, actions };
  } catch (err) {
    if (!(err instanceof ActionError)) throw err;
    return { allowed: err.status !== 409, note: err.message, fulfillment_orders: null, actions };
  }
}

// Runs one action on one of the order's fulfillment orders, if Shopify says
// it's possible now (`can` names the flag from describeFulfillmentOrder),
// logs it either way, and returns the order's state after it.
async function act(sellerId, orderId, fulfillmentOrderId, { action, can, cannot, reason = null, note = null }, run) {
  const order = await findOrder(sellerId, orderId);
  const creds = await storeFor(sellerId);
  const raw = (await fulfillmentOrdersOf(creds, order)).find((fo) => fo.id === String(fulfillmentOrderId));
  if (!raw) throw new ActionError("That fulfillment order isn't part of this order.", 404);
  const fo = describeFulfillmentOrder(raw);
  if (!fo[can]) throw new ActionError(cannot, 409);

  const entry = { action, source: 'seller', fulfillmentOrderId: fo.id, reason, note };
  try {
    await run(creds, raw);
  } catch (err) {
    const why = err.userError ? err.message : err.accessDenied ? MISSING_PERMISSION : "Shopify couldn't be reached";
    await logAction(sellerId, order.id, { ...entry, error: why });
    if (!err.userError && !err.accessDenied) console.warn(`[actions] order ${order.id} ${action}: ${err.response?.status || err.message}`);
    throw new ActionError(err.userError ? `Shopify said: ${err.message}` : why, err.userError ? 422 : err.accessDenied ? 409 : 502);
  }
  await logAction(sellerId, order.id, entry);
  return orderState(sellerId, order.id);
}

function holdOrder(sellerId, orderId, { fulfillmentOrderId, reason, note }) {
  return act(
    sellerId,
    orderId,
    fulfillmentOrderId,
    { action: 'hold', can: 'can_hold', cannot: "Shopify won't hold this now (it may be shipped already, or already on hold from here).", reason, note },
    (creds, fo) => shopifyService.holdFulfillmentOrder(creds.shopDomain, creds.accessToken, fo.id, { reason, reasonNotes: note || undefined, handle: HOLD_HANDLE })
  );
}

function releaseHold(sellerId, orderId, { fulfillmentOrderId }) {
  return act(
    sellerId,
    orderId,
    fulfillmentOrderId,
    { action: 'release', can: 'can_release', cannot: 'There is no hold from here to release (a hold another app placed is released there).' },
    (creds, fo) =>
      shopifyService.releaseFulfillmentHolds(
        creds.shopDomain,
        creds.accessToken,
        fo.id,
        fo.fulfillmentHolds.filter((hold) => hold.heldByRequestingApp).map((hold) => hold.id)
      )
  );
}

async function fulfillOrder(sellerId, orderId, { fulfillmentOrderId, notifyCustomer, tracking }) {
  const state = await act(
    sellerId,
    orderId,
    fulfillmentOrderId,
    { action: 'fulfill', can: 'can_fulfill', cannot: "Shopify won't fulfill this now (it may be on hold or shipped already).", note: tracking?.number ?? null },
    (creds, fo) => shopifyService.createFulfillment(creds.shopDomain, creds.accessToken, fo.id, { notifyCustomer, tracking })
  );
  await refreshOrder(sellerId, orderId);
  return state;
}

// The order's statuses from Shopify right after it shipped, so the dashboard
// shows "fulfilled" now rather than at the next webhook or sync.
async function refreshOrder(sellerId, orderId) {
  try {
    const order = await findOrder(sellerId, orderId);
    const creds = await sellerModel.getStoreCredentials(sellerId);
    const fresh = creds && (await shopifyService.fetchOrder(creds.shopDomain, creds.accessToken, order.shopify_order_id));
    if (fresh) await orderModel.upsertOrder(sellerId, fresh);
  } catch (err) {
    console.warn(`[actions] order ${orderId}: refreshing it after fulfilling failed: ${err.message}`);
  }
}

// The agent's HOLD when the seller turned auto-hold on: every fulfillment
// order of the order that can be held is, with `reason` (a HOLD_REASONS key)
// and the agent's headline as the note. Never throws. Returns the line for
// the alert, or null when auto-hold is off or there's nothing to hold.
async function autoHold(sellerId, shopifyOrderId, { reason, note }) {
  let order;
  try {
    const [[seller]] = await pool.query('SELECT auto_hold FROM sellers WHERE id = ?', [sellerId]);
    if (!seller?.auto_hold) return null;
    [[order]] = await pool.query('SELECT id, shopify_order_id FROM orders WHERE seller_id = ? AND shopify_order_id = ?', [
      sellerId,
      String(shopifyOrderId),
    ]);
    if (!order) return null;
    const creds = await storeFor(sellerId);
    const fulfillmentOrders = await fulfillmentOrdersOf(creds, order);
    const holdable = fulfillmentOrders.filter((fo) => describeFulfillmentOrder(fo).can_hold);
    if (!holdable.length) {
      return fulfillmentOrders.some((fo) => fo.fulfillmentHolds.some((hold) => hold.heldByRequestingApp)) ? 'Already on hold in Shopify.' : null;
    }
    const entry = { action: 'hold', source: 'agent', reason, note };
    let held = 0;
    let refused = null;
    for (const fo of holdable) {
      try {
        await shopifyService.holdFulfillmentOrder(creds.shopDomain, creds.accessToken, fo.id, { reason, reasonNotes: note || undefined, handle: HOLD_HANDLE });
        await logAction(sellerId, order.id, { ...entry, fulfillmentOrderId: fo.id });
        held++;
      } catch (err) {
        refused = err.userError ? `Shopify said: ${err.message}` : err.accessDenied ? MISSING_PERMISSION : "Shopify couldn't be reached";
        await logAction(sellerId, order.id, { ...entry, fulfillmentOrderId: fo.id, error: refused });
      }
    }
    if (held) return `Put on hold in Shopify (${HOLD_REASONS[reason] || reason}).`;
    return `Couldn't put it on hold in Shopify: ${refused}`;
  } catch (err) {
    const why = err instanceof ActionError ? err.message : "Shopify couldn't be reached";
    if (!(err instanceof ActionError)) console.warn(`[actions] seller ${sellerId} order ${shopifyOrderId}: auto-hold failed: ${err.message}`);
    if (order) await logAction(sellerId, order.id, { action: 'hold', source: 'agent', reason, note, error: why }).catch(() => {});
    return `Couldn't put it on hold in Shopify: ${why}`;
  }
}

// --- request bodies ---

const FULFILLMENT_ORDER_ID = /^\d{1,20}$/;

function parseFulfillmentOrderId(body) {
  const id = body?.fulfillment_order_id;
  return typeof id === 'string' && FULFILLMENT_ORDER_ID.test(id) ? id : null;
}

// POST .../hold: { fulfillment_order_id, reason, note? }
function parseHold(body) {
  const fulfillmentOrderId = parseFulfillmentOrderId(body);
  if (!fulfillmentOrderId) return { error: 'fulfillment_order_id must be the fulfillment order\'s number' };
  if (!Object.hasOwn(HOLD_REASONS, body.reason)) return { error: `reason must be one of: ${Object.keys(HOLD_REASONS).join(', ')}` };
  const note = body.note == null ? '' : body.note;
  if (typeof note !== 'string' || note.trim().length > MAX_NOTE) return { error: `note must be text of at most ${MAX_NOTE} characters` };
  return { fulfillmentOrderId, reason: body.reason, note: note.trim() || null };
}

// POST .../release: { fulfillment_order_id }
function parseRelease(body) {
  const fulfillmentOrderId = parseFulfillmentOrderId(body);
  return fulfillmentOrderId ? { fulfillmentOrderId } : { error: 'fulfillment_order_id must be the fulfillment order\'s number' };
}

const optionalText = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : null);

// POST .../fulfill: { fulfillment_order_id, notify_customer?, tracking_number?, tracking_company?, tracking_url? }
function parseFulfill(body) {
  const fulfillmentOrderId = parseFulfillmentOrderId(body);
  if (!fulfillmentOrderId) return { error: 'fulfillment_order_id must be the fulfillment order\'s number' };
  const notify = body.notify_customer ?? false;
  if (typeof notify !== 'boolean') return { error: 'notify_customer must be true or false' };
  const number = optionalText(body.tracking_number);
  const company = optionalText(body.tracking_company);
  const url = optionalText(body.tracking_url);
  if (number === null || number.length > 100) return { error: 'tracking_number must be text of at most 100 characters' };
  if (company === null || company.length > 100) return { error: 'tracking_company must be text of at most 100 characters' };
  if (url === null || url.length > 500 || (url && !/^https?:\/\/[^\s]+$/i.test(url))) return { error: 'tracking_url must be a link starting with https://' };
  if (!number && (company || url)) return { error: 'Add the tracking number too' };
  const tracking = number ? { number, ...(company ? { company } : {}), ...(url ? { url } : {}) } : null;
  return { fulfillmentOrderId, notifyCustomer: notify, tracking };
}

module.exports = {
  HOLD_REASONS,
  ActionError,
  describeFulfillmentOrder,
  orderState,
  holdOrder,
  releaseHold,
  fulfillOrder,
  autoHold,
  parseHold,
  parseRelease,
  parseFulfill,
};
