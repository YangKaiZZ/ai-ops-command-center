const pool = require('../config/db');

// The "Shopify" of a demo account (services/demo.js): the fulfillment calls
// orderActions.js makes, answered from the demo's own tables instead of a
// real store. Each order ships as one fulfillment order (its id is the
// order's id). A hold lasts from a hold in its action log until the next
// release or fulfillment there, so holding and releasing need no state of
// their own: act() logs them. Fulfilling marks the order shipped.

const LOCATION = 'Demo warehouse';
const SUPPORTED = { OPEN: ['CREATE_FULFILLMENT', 'HOLD'], ON_HOLD: ['RELEASE_HOLD', 'HOLD'], CLOSED: [], CANCELLED: [] };
const REASON_LABELS = {
  HIGH_RISK_OF_FRAUD: 'High risk of fraud',
  INVENTORY_OUT_OF_STOCK: 'Inventory out of stock',
  AWAITING_PAYMENT: 'Awaiting payment',
  INCORRECT_ADDRESS: 'Incorrect address',
  OTHER: 'Other',
};

// The order's fulfillment orders, shaped like shopifyService.fetchFulfillmentOrders's.
async function fetchFulfillmentOrders(order) {
  const [[row]] = await pool.query('SELECT status, financial_status FROM orders WHERE id = ?', [order.id]);
  if (!row) return null;
  const [items] = await pool.query(
    'SELECT title, variant_title, sku, quantity, fulfillable_quantity FROM order_line_items WHERE order_id = ? ORDER BY id',
    [order.id]
  );
  const [holds] = await pool.query(
    `SELECT id, reason, note FROM order_actions
     WHERE order_id = ? AND ok AND action = 'hold'
       AND id > COALESCE((SELECT MAX(id) FROM order_actions WHERE order_id = ? AND ok AND action IN ('release', 'fulfill')), 0)
     ORDER BY id`,
    [order.id, order.id]
  );
  const status = ['refunded', 'voided'].includes(row.financial_status)
    ? 'CANCELLED'
    : row.status === 'fulfilled'
      ? 'CLOSED'
      : holds.length
        ? 'ON_HOLD'
        : 'OPEN';
  return [
    {
      id: String(order.id),
      status,
      assignedLocation: { name: LOCATION },
      supportedActions: SUPPORTED[status].map((action) => ({ action })),
      fulfillmentHolds: holds.map((h) => ({
        id: String(h.id),
        reason: h.reason,
        reasonNotes: h.note,
        displayReason: REASON_LABELS[h.reason] || 'Other',
        heldByRequestingApp: true,
      })),
      lineItems: {
        nodes: items.map((item) => ({
          totalQuantity: item.quantity,
          remainingQuantity: status === 'CLOSED' ? 0 : item.fulfillable_quantity ?? item.quantity,
          lineItem: { title: item.title, variantTitle: item.variant_title, sku: item.sku },
        })),
      },
    },
  ];
}

// Holding and releasing: act() logs them, and the log is the hold.
async function holdFulfillmentOrder() {
  return { holdId: null };
}
async function releaseFulfillmentHolds() {
  return { status: 'OPEN' };
}

async function createFulfillment(order) {
  await pool.query("UPDATE orders SET status = 'fulfilled', synced_at = NOW() WHERE id = ?", [order.id]);
  await pool.query('UPDATE order_line_items SET fulfillable_quantity = 0 WHERE order_id = ?', [order.id]);
  return { fulfillmentId: null };
}

module.exports = { fetchFulfillmentOrders, holdFulfillmentOrder, releaseFulfillmentHolds, createFulfillment };
