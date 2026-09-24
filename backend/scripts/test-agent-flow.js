// End-to-end check of the agent flow with a fake order:
//   1. signed webhook -> /api/webhooks/orders-create (plus bad-signature + retry cases)
//   2. order lands in the DB
//   3. agent's MCP connection: tool list + real tool calls as that seller
//   4. agent decision: with DEEPSEEK_API_KEY set, waits for the backend's run to
//      save a row in `decisions` (that run also posts to Slack); without a key, skipped
//   5. dashboard endpoints: /api/orders, /api/inventory/low-stock, /api/decisions
//   6. freshness webhooks: orders/updated changes the stored status;
//      inventory_levels/update re-reads the variant from Shopify, and an item
//      that drops to its threshold triggers a low-stock decision (a second
//      LLM call when DEEPSEEK_API_KEY is set)
// The fake order and the decisions it produced are deleted at the end.
//
// Usage (backend must be running):  npm run test:agent
const path = require('path');
process.chdir(path.join(__dirname, '..')); // so dotenv finds the backend .env
require('dotenv').config();

const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const pool = require('../src/config/db');
const { JWT_SECRET } = require('../src/config/secrets');
const { connectAsSeller } = require('../src/services/mcpClient');
const { checkOrderStock } = require('../src/services/stockCheck');
const { describeTrigger, toOpenAITools, createLLMClient } = require('../src/services/agentService');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
let failures = 0;
let alertAfterId = null; // low-stock decisions after this id were made by the test

function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
}

async function waitForDecision(sellerId, orderNumber, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [rows] = await pool.query(
      'SELECT * FROM decisions WHERE seller_id = ? AND order_number = ? ORDER BY id DESC LIMIT 1',
      [sellerId, orderNumber]
    );
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

const sentWebhookIds = []; // removed from webhook_deliveries at the end

async function postWebhook(body, { hmac, shopDomain, webhookId, topic = 'orders/create' }) {
  if (webhookId) sentWebhookIds.push(webhookId);
  return axios.post(`${BASE}/api/webhooks/${topic.replace(/[/_]/g, '-')}`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': shopDomain,
      'X-Shopify-Topic': topic,
      'X-Shopify-Webhook-Id': webhookId,
    },
    validateStatus: () => true, // we assert on status ourselves
  });
}

// Orders a low-stock item and a healthy item (checked against live Shopify
// stock), plus a variant that doesn't exist in the store. Shopify never saw
// this fake order, so live stock doesn't count it; the missing variant is
// what makes it unshippable, so the HOLD path is exercised every run.
async function buildFakeOrder(sellerId) {
  const [low] = await pool.query(
    `SELECT shopify_variant_id, item_name, stock_quantity FROM inventory_items
     WHERE seller_id = ? AND stock_quantity <= low_stock_threshold ORDER BY stock_quantity LIMIT 1`,
    [sellerId]
  );
  const [ok] = await pool.query(
    `SELECT shopify_variant_id, item_name, stock_quantity FROM inventory_items
     WHERE seller_id = ? AND stock_quantity > low_stock_threshold ORDER BY stock_quantity DESC LIMIT 1`,
    [sellerId]
  );

  const lineItems = [];
  if (low[0]) lineItems.push({ ...low[0], quantity: Math.max(1, low[0].stock_quantity + 1) });
  if (ok[0]) lineItems.push({ ...ok[0], quantity: 1 });
  lineItems.push({ shopify_variant_id: '1', item_name: 'Discontinued Test Item', quantity: 1 });

  const stamp = Date.now();
  return {
    id: 9000000000000 + (stamp % 1000000000),
    name: `#TEST-${String(stamp).slice(-4)}`,
    created_at: new Date(stamp).toISOString().replace(/\.\d{3}Z$/, '+00:00'), // Shopify's format, e.g. 2026-09-21T15:38:00+00:00
    financial_status: 'paid',
    fulfillment_status: null,
    total_price: '99.00',
    customer: { first_name: 'Test', last_name: 'Buyer' },
    line_items: lineItems.map((li) => ({
      title: li.item_name,
      variant_title: null,
      variant_id: Number(li.shopify_variant_id),
      quantity: li.quantity,
    })),
  };
}

async function main() {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) throw new Error('SHOPIFY_WEBHOOK_SECRET is not set in .env');
  await axios.get(`${BASE}/health`).catch(() => {
    throw new Error(`Backend not reachable at ${BASE} - start it first`);
  });

  const [sellers] = await pool.query(
    'SELECT id, shopify_shop_domain FROM sellers WHERE shopify_shop_domain IS NOT NULL ORDER BY id LIMIT 1'
  );
  if (!sellers[0]) throw new Error('No seller has a connected Shopify store');
  const seller = sellers[0];
  const order = await buildFakeOrder(seller.id);
  console.log(`Seller #${seller.id} (${seller.shopify_shop_domain}), fake order ${order.name}:`);
  for (const li of order.line_items) console.log(`    ${li.quantity} x ${li.title} (variant ${li.variant_id})`);

  try {
    console.log('\n1. Webhook endpoint');
    const body = JSON.stringify(order);
    const webhookId = crypto.randomUUID();
    const base = { shopDomain: seller.shopify_shop_domain, webhookId };

    const bad = await postWebhook(body, { ...base, hmac: sign(body, 'wrong-secret') });
    check(bad.status === 401, 'bad signature rejected', `HTTP ${bad.status}`);

    const tampered = await postWebhook(body.replace('99.00', '0.01'), { ...base, hmac: sign(body, secret) });
    check(tampered.status === 401, 'tampered body rejected', `HTTP ${tampered.status}`);

    const good = await postWebhook(body, { ...base, hmac: sign(body, secret) });
    check(good.status === 200 && good.data.received === true, 'valid signature accepted', `HTTP ${good.status} ${JSON.stringify(good.data)}`);

    const retry = await postWebhook(body, { ...base, hmac: sign(body, secret) });
    check(retry.data.duplicate === true, 'Shopify retry (same webhook id) deduped', JSON.stringify(retry.data));

    console.log('\n2. Order stored');
    const [stored] = await pool.query(
      'SELECT id, order_number, status, financial_status, buyer_name FROM orders WHERE seller_id = ? AND shopify_order_id = ?',
      [seller.id, String(order.id)]
    );
    check(stored.length === 1, 'webhook order upserted', stored[0] && JSON.stringify(stored[0]));
    const storedOrderId = stored[0]?.id;

    console.log('\n3. MCP tools (same connection the agent uses)');
    const mcp = await connectAsSeller(seller.id);
    try {
      const names = mcp.tools.map((t) => t.name);
      check(names.length > 0 && !names.includes('sync_latest_data'), 'read-only tools exposed', names.join(', '));
      const openAITools = toOpenAITools(mcp.tools);
      check(openAITools.every((t) => t.function.parameters.type === 'object'), 'converted to OpenAI function schema');

      const pending = await mcp.callTool('get_pending_orders');
      const pendingOrders = pending.isError ? [] : JSON.parse(pending.text);
      check(!pending.isError, 'get_pending_orders', `${pendingOrders.length} pending`);
      check(pendingOrders.some((o) => o.order_number === order.name), `pending list includes ${order.name}`);

      const lowStock = await mcp.callTool('check_low_stock');
      const lowItems = lowStock.isError ? [] : JSON.parse(lowStock.text);
      check(!lowStock.isError, 'check_low_stock', `${lowItems.length} low: ${lowItems.map((i) => i.item_name).join(', ')}`);

      const blocked = await mcp.callTool('sync_latest_data');
      check(blocked.isError, 'sync_latest_data blocked for the agent', blocked.text);
    } finally {
      await mcp.close();
    }

    console.log('\n4. Agent decision');
    const trigger = { type: 'order_created', order };
    const stockCheck = await checkOrderStock(seller.id, order);
    for (const line of stockCheck.lines) {
      console.log(`    stock check: ${line.quantity} x ${line.title} - ${line.stock_left_after_order} left after order (${line.source}) -> ${line.can_ship ? 'can ship' : 'CANNOT ship'}`);
    }
    const tracked = stockCheck.lines.filter((l) => l.variant_id !== '1');
    check(tracked.every((l) => l.source === 'shopify'), 'stock check read live Shopify stock', tracked.map((l) => l.source).join(', '));
    const missing = stockCheck.lines.find((l) => l.variant_id === '1');
    check(missing && !missing.can_ship && missing.stock_left_after_order === 'unknown', 'variant missing from Shopify -> cannot ship', missing?.source);
    const expectedAction = stockCheck.canShip ? null : 'hold';
    console.log('    prompt the model will get:\n' + describeTrigger(trigger, stockCheck).replace(/^/gm, '      '));
    let decisionRow = null;
    if (!process.env.DEEPSEEK_API_KEY) {
      try {
        createLLMClient();
        check(false, 'expected missing-key error');
      } catch (err) {
        console.log(`  SKIP  LLM call (expected): ${err.message}`);
      }
    } else {
      // The webhook above already started the backend's own agent run (which
      // also posts to Slack). Wait for it to save its decision instead of
      // running a second copy here.
      decisionRow = await waitForDecision(seller.id, order.name, 60000);
      check(
        Boolean(decisionRow),
        'decision saved to decisions table',
        decisionRow ? `#${decisionRow.id} ${decisionRow.action_taken}` : 'none within 60s - check the backend log'
      );
      if (decisionRow) {
        check(decisionRow.order_id === storedOrderId, 'decision linked to the order row', `order_id ${decisionRow.order_id}`);
        if (expectedAction) {
          check(decisionRow.action_taken === expectedAction, `unshippable order recorded as ${expectedAction}`, decisionRow.action_taken);
        }
        console.log(decisionRow.reasoning.replace(/^/gm, '      '));
      }
    }

    console.log('\n5. Dashboard endpoints');
    const token = jwt.sign({ sellerId: seller.id }, JWT_SECRET, { expiresIn: '5m' });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const { data: ordersData } = await axios.get(`${BASE}/api/orders`, auth);
    const listed = ordersData.orders.find((o) => o.order_number === order.name);
    check(Boolean(listed?.status), 'GET /api/orders includes status', listed && `${order.name}: ${listed.status} / ${listed.financial_status}`);

    const { data: lowData } = await axios.get(`${BASE}/api/inventory/low-stock`, auth);
    check(Array.isArray(lowData.low_stock_items), 'GET /api/inventory/low-stock', `${lowData.low_stock_items.length} items`);

    const { data: decData } = await axios.get(`${BASE}/api/decisions?limit=5`, auth);
    const feed = decData.decisions;
    check(Array.isArray(feed), 'GET /api/decisions', `${feed.length} returned`);
    check(
      feed.every((d, i) => i === 0 || new Date(feed[i - 1].created_at) >= new Date(d.created_at)),
      'decisions are newest first'
    );
    if (decisionRow) check(feed[0]?.id === decisionRow.id, 'new decision is first in the feed');

    console.log('\n6. Freshness webhooks');
    const signed = (payload, topic) => {
      const raw = JSON.stringify(payload);
      return postWebhook(raw, { hmac: sign(raw, secret), shopDomain: seller.shopify_shop_domain, webhookId: crypto.randomUUID(), topic });
    };

    const updated = await signed({ ...order, fulfillment_status: 'fulfilled' }, 'orders/updated');
    const [afterUpdate] = await pool.query('SELECT status FROM orders WHERE seller_id = ? AND shopify_order_id = ?', [seller.id, String(order.id)]);
    check(updated.status === 200 && afterUpdate[0]?.status === 'fulfilled', 'orders/updated stores the new status', `HTTP ${updated.status}, status ${afterUpdate[0]?.status}`);

    const unknownItem = await signed({ inventory_item_id: 1, location_id: 1, available: 0 }, 'inventory_levels/update');
    check(unknownItem.status === 200, 'inventory_levels/update for an unknown item is acknowledged', `HTTP ${unknownItem.status}`);

    // An item at or below its threshold in Shopify, recorded as healthy here:
    // the webhook's re-read should bring the real number back and see it cross.
    const [lowRows] = await pool.query(
      `SELECT * FROM inventory_items WHERE seller_id = ? AND shopify_inventory_item_id IS NOT NULL
       AND stock_quantity <= low_stock_threshold ORDER BY stock_quantity LIMIT 1`,
      [seller.id]
    );
    const low = lowRows[0];
    if (!low) {
      console.log('  SKIP  low-stock webhook: no synced item is at its threshold (or inventory_item_id not synced yet)');
    } else {
      const [[{ maxId }]] = await pool.query('SELECT COALESCE(MAX(id), 0) AS maxId FROM decisions WHERE seller_id = ?', [seller.id]);
      alertAfterId = maxId;
      await pool.query('UPDATE inventory_items SET stock_quantity = ? WHERE id = ?', [low.low_stock_threshold + 10, low.id]);
      const res = await signed({ inventory_item_id: Number(low.shopify_inventory_item_id), location_id: 1, available: low.stock_quantity }, 'inventory_levels/update');
      check(res.status === 200, 'inventory_levels/update acknowledged', `${low.item_name}, HTTP ${res.status}`);

      let refreshed = null;
      for (let i = 0; i < 20 && refreshed?.stock_quantity !== low.stock_quantity; i++) {
        await new Promise((r) => setTimeout(r, 500));
        [[refreshed]] = await pool.query('SELECT stock_quantity FROM inventory_items WHERE id = ?', [low.id]);
      }
      check(refreshed?.stock_quantity === low.stock_quantity, 'stock re-read from Shopify', `${low.low_stock_threshold + 10} -> ${refreshed?.stock_quantity}`);

      if (process.env.DEEPSEEK_API_KEY) {
        let alert = null;
        const deadline = Date.now() + 60000;
        while (!alert && Date.now() < deadline) {
          [[alert]] = await pool.query(
            "SELECT * FROM decisions WHERE seller_id = ? AND id > ? AND action_taken = 'low_stock_alert' ORDER BY id LIMIT 1",
            [seller.id, alertAfterId]
          );
          if (!alert) await new Promise((r) => setTimeout(r, 1000));
        }
        check(Boolean(alert), 'item crossing its threshold triggered a RESTOCK decision', alert ? `#${alert.id}` : 'none within 60s - check the backend log');
        if (alert) console.log(alert.reasoning.replace(/^/gm, '      '));
      }
    }
  } finally {
    // With no key the backend's run stops before saving anything; give it a
    // moment to finish either way before pulling the order out from under it.
    await new Promise((r) => setTimeout(r, 2000));
    await pool.query('DELETE FROM decisions WHERE seller_id = ? AND order_number = ?', [seller.id, order.name]);
    if (alertAfterId != null) {
      await pool.query("DELETE FROM decisions WHERE seller_id = ? AND id > ? AND action_taken = 'low_stock_alert'", [seller.id, alertAfterId]);
    }
    await pool.query('DELETE FROM orders WHERE seller_id = ? AND shopify_order_id = ?', [seller.id, String(order.id)]);
    await pool.query('DELETE FROM jobs WHERE dedupe_key = ?', [`agent:order:${seller.id}:${order.id}`]);
    if (sentWebhookIds.length) await pool.query('DELETE FROM webhook_deliveries WHERE webhook_id IN (?)', [sentWebhookIds]);
    console.log(`\nCleaned up fake order ${order.name} and its decision.`);
  }
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    failures++;
  })
  .finally(async () => {
    await pool.end();
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
  });
