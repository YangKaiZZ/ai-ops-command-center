const pool = require('../config/db');
const inventory = require('../models/inventoryModel');
const restockForecast = require('../services/restockForecast');

const MAX_THRESHOLD = 1000000;

// A threshold from a request body: a whole number from 0 up, or null.
function parseThreshold(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 && n <= MAX_THRESHOLD ? n : null;
}

// GET /api/inventory/low-stock
// This is the exact query the "check_low_stock" MCP tool will call in Phase 3.
async function getLowStock(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM inventory_items
       WHERE seller_id = ?
       AND stock_quantity <= low_stock_threshold
       ORDER BY stock_quantity ASC`,
      [req.sellerId]
    );
    res.json({ low_stock_items: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch low stock items' });
  }
}

// GET /api/inventory
// Every tracked item with its threshold (low ones first), for editing thresholds.
async function getInventory(req, res) {
  try {
    res.json({ items: await inventory.listInventory(req.sellerId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch inventory' });
  }
}

// GET /api/inventory/forecast?days=30&cover_days=30
// How fast each tracked item sells over the last `days`, when it runs out at
// that pace and how many to reorder to last `cover_days`, soonest to run out
// first, with how much order history that's based on.
async function getForecast(req, res) {
  const parsed = restockForecast.parseForecastQuery(req.query);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    res.json(await restockForecast.getForecast(req.sellerId, parsed));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not work out the restock forecast' });
  }
}

// PATCH /api/inventory/:id   Body: { low_stock_threshold }
// The item counts as low at or below this number. Changing it never sends an
// alert by itself; alerts come when stock drops past the threshold.
async function updateItem(req, res) {
  const id = Number(req.params.id);
  const threshold = parseThreshold(req.body?.low_stock_threshold);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid item id' });
  if (threshold === null) {
    return res.status(400).json({ error: `The threshold must be a whole number from 0 to ${MAX_THRESHOLD}` });
  }
  try {
    const item = await inventory.setThreshold(req.sellerId, id, threshold);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json({ item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update the item' });
  }
}

module.exports = { getLowStock, getInventory, getForecast, updateItem, parseThreshold };
