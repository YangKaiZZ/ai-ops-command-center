const pool = require('../config/db');
const { verifyOrderActionToken } = require('../services/actionLinks');
const actions = require('../services/orderActions');

// The confirm page behind "Put on hold" / "Mark fulfilled" in Slack and email
// alerts (actionLinks.js). No sign-in: the signed token names the one order
// and the one action it allows. Opening it only reads; POST acts.

const LINK_ERRORS = {
  invalid: [404, "This link isn't valid."],
  expired: [410, "This link has expired. Open the order in the dashboard to do it from there."],
};

// The token's order and action, or sends the error and returns null.
async function linkFor(req, res) {
  const verified = verifyOrderActionToken(req.params.token);
  if (verified.error) {
    const [status, error] = LINK_ERRORS[verified.error];
    res.status(status).json({ error });
    return null;
  }
  const order = await actions.orderForAlert(verified.sellerId, verified.orderId);
  if (!order) {
    res.status(404).json({ error: 'That order is no longer there.' });
    return null;
  }
  return { ...verified, order };
}

function sendError(res, err, fallback) {
  if (err instanceof actions.ActionError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: fallback });
}

// Only what the page needs: the order in Shopify now, not the log of what
// was done to it.
const stateForLink = ({ allowed, note, fulfillment_orders }) => ({ allowed, note, fulfillment_orders, actions: [] });

// GET /api/act/:token
// { action, order, business_name, expires_at, state }: the order as Shopify has it now.
async function getLink(req, res) {
  try {
    const link = await linkFor(req, res);
    if (!link) return;
    const [[seller]] = await pool.query('SELECT business_name FROM sellers WHERE id = ?', [link.sellerId]);
    const state = await actions.orderState(link.sellerId, link.orderId);
    res.json({
      action: link.action,
      order: link.order,
      business_name: seller?.business_name ?? null,
      expires_at: link.expiresAt.toISOString(),
      state: stateForLink(state),
    });
  } catch (err) {
    sendError(res, err, 'Could not load the order');
  }
}

// POST /api/act/:token
// The body the dashboard sends for the same action: hold { fulfillment_order_id,
// reason, note? } or fulfill { fulfillment_order_id, notify_customer?, tracking_* }.
async function postLink(req, res) {
  try {
    const link = await linkFor(req, res);
    if (!link) return;
    const input = link.action === 'hold' ? actions.parseHold(req.body) : actions.parseFulfill(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const run = link.action === 'hold' ? actions.holdOrder : actions.fulfillOrder;
    const state = await run(link.sellerId, link.orderId, { ...input, source: 'link' });
    res.json(stateForLink(state));
  } catch (err) {
    sendError(res, err, 'Could not do that in Shopify');
  }
}

module.exports = { getLink, postLink };
