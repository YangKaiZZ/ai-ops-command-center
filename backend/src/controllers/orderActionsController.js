const actions = require('../services/orderActions');

// Holding and fulfilling an order in Shopify (services/orderActions.js).
// Reading works with an API key too; acting needs a dashboard sign-in
// (ordersRoutes.js), so Claude Desktop can look but not ship.

function sendError(res, err, fallback) {
  if (err instanceof actions.ActionError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: fallback });
}

// GET /api/orders/:id/shopify
async function getShopifyState(req, res) {
  try {
    res.json(await actions.orderState(req.sellerId, Number(req.params.id)));
  } catch (err) {
    sendError(res, err, "Could not load the order's Shopify status");
  }
}

// POST handlers: parse the body, run the action, answer with the order's
// state after it.
function handler(parse, run, fallback) {
  return async (req, res) => {
    const input = parse(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    try {
      res.json(await run(req.sellerId, Number(req.params.id), input));
    } catch (err) {
      sendError(res, err, fallback);
    }
  };
}

// POST /api/orders/:id/hold    { fulfillment_order_id, reason, note? }
const holdOrder = handler(actions.parseHold, actions.holdOrder, 'Could not put the order on hold');
// POST /api/orders/:id/release { fulfillment_order_id }
const releaseHold = handler(actions.parseRelease, actions.releaseHold, 'Could not release the hold');
// POST /api/orders/:id/fulfill { fulfillment_order_id, notify_customer?, tracking_number?, tracking_company?, tracking_url? }
const fulfillOrder = handler(actions.parseFulfill, actions.fulfillOrder, 'Could not fulfill the order');

module.exports = { getShopifyState, holdOrder, releaseHold, fulfillOrder };
