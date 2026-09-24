const pool = require('../config/db');

// Decides in code, not in the model, whether each line item of an order can
// ship: the model kept overriding stock data with its own assumptions (e.g.
// "gift cards don't need stock"). The agent gets these results as facts.
//
// Uses our synced inventory snapshot. The webhook fires as the order is
// created, so that snapshot is normally from before this order — i.e. the
// stock that was available to fill it.
async function checkOrderStock(sellerId, order) {
  const lineItems = order.line_items || [];
  const variantIds = lineItems.filter((li) => li.variant_id != null).map((li) => String(li.variant_id));

  const stock = new Map();
  if (variantIds.length) {
    const [rows] = await pool.query(
      'SELECT shopify_variant_id, stock_quantity FROM inventory_items WHERE seller_id = ? AND shopify_variant_id IN (?)',
      [sellerId, variantIds]
    );
    for (const row of rows) stock.set(row.shopify_variant_id, row.stock_quantity);
  }

  const lines = lineItems.map((li) => {
    const variantId = li.variant_id != null ? String(li.variant_id) : null;
    const title = `${li.title}${li.variant_title ? ' - ' + li.variant_title : ''}`;
    // No inventory row: Shopify doesn't track this variant (the sync skips
    // those) or it's a custom line item, so there's no stock limit to hit.
    if (!variantId || !stock.has(variantId)) {
      return { title, variant_id: variantId, quantity: li.quantity, stock_on_hand: 'not tracked', can_ship: true };
    }
    const onHand = stock.get(variantId);
    return { title, variant_id: variantId, quantity: li.quantity, stock_on_hand: onHand, can_ship: li.quantity <= onHand };
  });

  const short = lines.filter((l) => !l.can_ship);
  return { lines, canShip: short.length === 0, short };
}

module.exports = { checkOrderStock };
