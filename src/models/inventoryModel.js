const pool = require('../config/db');

// Current stock + threshold per variant, to tell which items *cross* the
// threshold on an update instead of re-alerting on every sync.
async function getStockSnapshot(sellerId) {
  const [rows] = await pool.query(
    'SELECT shopify_variant_id, stock_quantity, low_stock_threshold FROM inventory_items WHERE seller_id = ?',
    [sellerId]
  );
  return new Map(rows.map((row) => [row.shopify_variant_id, row]));
}

async function upsertInventoryItem(sellerId, item) {
  await pool.query(
    `INSERT INTO inventory_items
       (seller_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, item_name, stock_quantity)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       shopify_product_id = VALUES(shopify_product_id),
       shopify_inventory_item_id = VALUES(shopify_inventory_item_id),
       item_name = VALUES(item_name),
       stock_quantity = VALUES(stock_quantity),
       synced_at = CURRENT_TIMESTAMP`,
    [sellerId, item.productId, item.variantId, item.inventoryItemId, item.itemName, item.stock]
  );
}

// After a complete product sync: any other row is a variant that was deleted
// in Shopify or stopped being tracked.
async function deleteInventoryExcept(sellerId, keepVariantIds) {
  await pool.query(
    keepVariantIds.length
      ? 'DELETE FROM inventory_items WHERE seller_id = ? AND shopify_variant_id NOT IN (?)'
      : 'DELETE FROM inventory_items WHERE seller_id = ?',
    [sellerId, keepVariantIds]
  );
}

// inventory_levels/update webhooks name the inventory item, not the variant.
async function findByInventoryItemId(sellerId, inventoryItemId) {
  const [rows] = await pool.query(
    'SELECT * FROM inventory_items WHERE seller_id = ? AND shopify_inventory_item_id = ?',
    [sellerId, String(inventoryItemId)]
  );
  return rows[0] || null;
}

async function updateStock(id, stock) {
  await pool.query('UPDATE inventory_items SET stock_quantity = ?, synced_at = CURRENT_TIMESTAMP WHERE id = ?', [stock, id]);
}

async function deleteInventoryItem(id) {
  await pool.query('DELETE FROM inventory_items WHERE id = ?', [id]);
}

module.exports = {
  getStockSnapshot,
  upsertInventoryItem,
  deleteInventoryExcept,
  findByInventoryItemId,
  updateStock,
  deleteInventoryItem,
};
