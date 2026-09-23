// End-to-end check of the Phase 4 flow with a fake order, everything up to
// the LLM call:
//   1. signed webhook -> /api/webhooks/orders-create (plus bad-signature + retry cases)
//   2. order lands in the DB
//   3. agent's MCP connection: tool list + real tool calls as that seller
//   4. LLM step (expected to fail until DEEPSEEK_API_KEY is set)
// The fake order is deleted at the end.
//
// Usage (backend must be running):  npm run test:agent
const path = require('path');
process.chdir(path.join(__dirname, '..')); // so dotenv finds the backend .env
require('dotenv').config();

const crypto = require('crypto');
const axios = require('axios');
const pool = require('../src/config/db');
const { connectAsSeller } = require('../src/services/mcpClient');
const { runAgent, describeTrigger, toOpenAITools, createLLMClient } = require('../src/services/agentService');

const BASE = `http://localhost:${process.env.PORT || 3000}`;
let failures = 0;

function check(ok, label, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

async function postWebhook(body, { hmac, shopDomain, webhookId }) {
  return axios.post(`${BASE}/api/webhooks/orders-create`, body, {
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Shop-Domain': shopDomain,
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Webhook-Id': webhookId,
    },
    validateStatus: () => true, // we assert on status ourselves
  });
}

// Orders one item that's low on stock (more than we have) and one healthy
// item, so the agent has something real to decide about.
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
  if (low[0]) lineItems.push({ ...low[0], quantity: low[0].stock_quantity + 1 });
  if (ok[0]) lineItems.push({ ...ok[0], quantity: 1 });
  if (!lineItems.length) lineItems.push({ shopify_variant_id: '1', item_name: 'Fake Item', quantity: 1 });

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
      'SELECT order_number, status, financial_status, buyer_name FROM orders WHERE seller_id = ? AND shopify_order_id = ?',
      [seller.id, String(order.id)]
    );
    check(stored.length === 1, 'webhook order upserted', stored[0] && JSON.stringify(stored[0]));

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

    console.log('\n4. LLM step');
    const trigger = { type: 'order_created', order };
    console.log('    prompt the model will get:\n' + describeTrigger(trigger).replace(/^/gm, '      '));
    if (!process.env.DEEPSEEK_API_KEY) {
      try {
        createLLMClient();
        check(false, 'expected missing-key error');
      } catch (err) {
        console.log(`  SKIP  LLM call (expected): ${err.message}`);
      }
    } else {
      // Key is set: run the real agent. The backend is running the same flow
      // for the webhook above, so expect its decision in Slack/console too.
      const decision = await runAgent(seller.id, trigger);
      check(Boolean(decision), 'agent produced a decision');
      console.log(decision.replace(/^/gm, '      '));
    }
  } finally {
    // Give the backend's own background agent run a moment to finish before
    // we pull the order out from under it.
    await new Promise((r) => setTimeout(r, 2000));
    await pool.query('DELETE FROM orders WHERE seller_id = ? AND shopify_order_id = ?', [seller.id, String(order.id)]);
    console.log(`\nCleaned up fake order ${order.name}.`);
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
