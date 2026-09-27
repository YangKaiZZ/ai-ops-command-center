// End-to-end check of "Try the demo", run in-process against the real
// database (every demo account made here is removed at the end, and nothing
// calls Shopify or DeepSeek: both are made to fail loudly if anything tries):
//   1. POST /api/auth/demo: a signed-in demo account with a sample store:
//      orders, line items, fraud checks, decisions with ratings, stock,
//      restock forecasts, a late order, the Overview
//   2. holding, releasing and fulfilling in the sample store, logged
//   3. what reaches outside is refused (store, alert channels, API keys,
//      "send now"); sync says there's nothing to sync; the agent never runs
//   4. expired demo accounts are removed; the cap and DEMO_ENABLED=false
//
// Usage:  npm run test:demo
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const http = require('http');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  // A "DeepSeek" that counts calls: a demo must never reach it.
  let modelCalls = 0;
  const llm = http.createServer((req, res) => {
    modelCalls++;
    res.writeHead(500).end();
  });
  await new Promise((resolve) => llm.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.address().port}` });
  require('dotenv').config({ quiet: true });

  // Any real Shopify call fails the run.
  const shopifyService = require('../src/services/shopifyService');
  let shopifyCalls = 0;
  for (const name of Object.keys(shopifyService)) {
    if (typeof shopifyService[name] === 'function' && name !== 'nextPageUrl') {
      shopifyService[name] = async () => {
        shopifyCalls++;
        throw new Error(`demo called Shopify (${name})`);
      };
    }
  }

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const demo = require('../src/services/demo');
  const { runAgent } = require('../src/services/agentService');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const request = async (method, route, { token, body } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const made = [];
  const startDemo = async () => {
    const res = await request('POST', '/api/auth/demo');
    if (res.body?.sellerId) made.push(res.body.sellerId);
    return res;
  };

  try {
    console.log('\n1. Starting the demo');
    let res = await request('GET', '/api/auth/config');
    check(res.body?.demo_available === true, 'the sign-in page is told the demo is on');
    res = await startDemo();
    const { token, sellerId } = res.body || {};
    check(res.status === 201 && token && res.body.business_name === 'Demo Store', 'a demo account, signed in', `${res.status} ${JSON.stringify(res.body?.demo)}`);
    const hoursLeft = (new Date(res.body?.demo?.expires_at) - Date.now()) / 3600e3;
    check(hoursLeft > 3.9 && hoursLeft <= 4, 'it lasts 4 hours', hoursLeft.toFixed(2));

    res = await request('GET', '/api/settings', { token });
    const settings = res.body || {};
    check(
      settings.demo?.expires_at && settings.store?.connected === true && settings.store.shop_domain === 'Sample store (demo)' && settings.shopify_actions?.allowed && settings.shopify_actions.auto_hold,
      'settings: a demo, its sample store shown as connected, holding allowed, auto-hold on',
      JSON.stringify({ demo: settings.demo, store: settings.store, actions: settings.shopify_actions })
    );

    res = await request('GET', '/api/orders?limit=100', { token });
    const orders = res.body?.orders || [];
    check(res.status === 200 && res.body.total >= 40, 'about 45 orders over the last month', String(res.body?.total));
    const byNumber = Object.fromEntries(orders.map((o) => [o.order_number, o]));
    const newest = orders[0];
    check(newest?.risk?.level === 'high' && newest.risk.flagged && newest.latest_decision?.action_taken === 'hold', 'the newest: high fraud risk, held by the agent', JSON.stringify(newest?.risk));
    check(orders.some((o) => o.buyer_name === null) && orders.some((o) => o.buyer_name && o.buyer_name !== 'Guest'), 'customers named, and a few with the name held back');
    res = await request('GET', '/api/orders?risk=flagged&limit=10', { token });
    check(res.body?.total === 3, 'three flagged for fraud (high, medium, and one last week)', String(res.body?.total));

    res = await request('GET', `/api/orders/${newest.id}`, { token });
    check(res.status === 200 && res.body.line_items?.length === 1 && res.body.line_items_note === null && res.body.decisions?.length === 1, 'an order page: its items and the decision, no Shopify call', `${res.body?.line_items?.length} items, ${res.body?.decisions?.length} decisions`);

    res = await request('GET', '/api/decisions?limit=200', { token });
    const decisions = res.body?.decisions || [];
    const ratings = res.body?.ratings;
    check(decisions.length >= 40 && ratings?.up > 10 && ratings.down === 1, 'decisions, most rated right, one wrong', JSON.stringify({ n: decisions.length, up: ratings?.up, down: ratings?.down }));
    const wrong = decisions.find((d) => d.feedback === 'down');
    check(/pending/.test(wrong?.reasoning) && /Bank transfers/.test(wrong.feedback_note), 'the wrong call: a pending bank transfer, with the note the agent learns from', wrong?.feedback_note);
    const restock = decisions.filter((d) => d.action_taken === 'low_stock_alert');
    check(restock.length === 2 && /RESTOCK — Linen Scarf is running low\.\n\n- Linen Scarf: 2 left/.test(restock[0]?.reasoning) && /Reorder \d+ to last 30 days/.test(restock[0].reasoning), 'restock calls, with numbers from the forecast', restock[0]?.reasoning.split('\n').slice(3).join(' '));

    res = await request('GET', '/api/inventory/forecast', { token });
    const scarf = res.body?.items?.find((i) => i.item_name === 'Linen Scarf');
    check(scarf?.reorder_quantity > 0 && scarf.days_left > 0 && res.body.history.days >= 28, 'stock forecasts from the sample orders', JSON.stringify(scarf && { per_day: scarf.per_day, days_left: scarf.days_left, reorder: scarf.reorder_quantity }));
    check(restock[0]?.reasoning.includes(`Reorder ${scarf?.reorder_quantity} to`), "the restock call says the forecast's own reorder amount");

    res = await request('GET', `/api/overview?from=${encodeURIComponent(new Date(Date.now() - 7 * 86400e3).toISOString())}`, { token });
    const o = res.body || {};
    check(o.orders?.count > 5 && o.orders.needs_action >= 5 && o.fraud?.flagged === 2 && o.fraud.previous_flagged === 1 && o.stock?.low >= 2 && o.decisions?.total > 5, 'the Overview has something in every tile', JSON.stringify({ orders: o.orders?.count, action: o.orders?.needs_action, fraud: o.fraud, low: o.stock?.low }));

    res = await request('GET', '/api/orders?needs_action=true&limit=20', { token });
    const late = res.body?.orders?.find((ord) => (Date.now() - new Date(ord.order_placed_at)) / 3600e3 > 40);
    check(Boolean(late), 'an order paid two days ago and still not shipped (late)', late?.order_number);

    console.log('\n2. Holding and fulfilling in the sample store');
    res = await request('GET', `/api/orders/${newest.id}/shopify`, { token });
    let fo = res.body?.fulfillment_orders?.[0];
    check(
      res.body?.allowed && fo?.status === 'on_hold' && fo.can_release && !fo.can_fulfill && fo.holds[0]?.reason === 'HIGH_RISK_OF_FRAUD' && fo.location === 'Demo warehouse',
      'the high-risk order is on hold from here, by the agent',
      JSON.stringify(fo)
    );
    check(res.body?.actions?.[0]?.source === 'agent', 'the log says the agent held it');
    res = await request('POST', `/api/orders/${newest.id}/release`, { token, body: { fulfillment_order_id: fo.id } });
    fo = res.body?.fulfillment_orders?.[0];
    check(res.status === 200 && fo?.status === 'open' && fo.can_fulfill && fo.can_hold, 'releasing it', `${res.status} ${fo?.status}`);
    res = await request('POST', `/api/orders/${newest.id}/hold`, { token, body: { fulfillment_order_id: fo.id, reason: 'OTHER', note: 'Calling the buyer' } });
    fo = res.body?.fulfillment_orders?.[0];
    check(res.status === 200 && fo?.status === 'on_hold' && fo.holds[0]?.note === 'Calling the buyer', 'holding it again, with a note', JSON.stringify(fo?.holds));
    res = await request('POST', `/api/orders/${newest.id}/fulfill`, { token, body: { fulfillment_order_id: fo.id } });
    check(res.status === 409, "on hold: it can't be fulfilled", res.body?.error);
    await request('POST', `/api/orders/${newest.id}/release`, { token, body: { fulfillment_order_id: fo.id } });
    res = await request('POST', `/api/orders/${newest.id}/fulfill`, { token, body: { fulfillment_order_id: fo.id, tracking_number: '1Z999' } });
    fo = res.body?.fulfillment_orders?.[0];
    check(res.status === 200 && fo?.status === 'closed' && fo.items.every((i) => i.remaining === 0), 'fulfilled', `${res.status} ${fo?.status}`);
    res = await request('GET', `/api/orders/${newest.id}`, { token });
    check(res.body?.order?.status === 'fulfilled', 'and shown as fulfilled at once', res.body?.order?.status);
    res = await request('GET', `/api/orders/${newest.id}/shopify`, { token });
    check(res.body?.actions?.map((a) => a.action).join() === 'fulfill,release,hold,release,hold', 'every step logged, newest first', res.body?.actions?.map((a) => a.action).join());
    const refunded = orders.find((ord) => ord.financial_status === 'refunded');
    res = await request('GET', `/api/orders/${refunded?.id}/shopify`, { token });
    check(res.body?.fulfillment_orders?.[0]?.status === 'cancelled', 'a refunded order: nothing to do', res.body?.fulfillment_orders?.[0]?.status);

    console.log("\n3. What a demo can't do");
    for (const [method, route, body] of [
      ['PUT', '/api/settings/slack', { webhook_url: 'https://hooks.slack.com/services/T/B/x' }],
      ['PUT', '/api/settings/email', { email: 'someone@example.test' }],
      ['POST', '/api/settings/telegram'],
      ['POST', '/api/settings/api-keys', { name: 'x' }],
      ['POST', '/api/settings/test-alert'],
      ['POST', '/api/settings/reports/summary'],
      ['POST', '/api/store/connect', { shop_domain: 'x.myshopify.com', access_token: 'shpat_x' }],
      ['DELETE', '/api/store'],
      ['POST', '/api/shopify/connect', { shop: 'x.myshopify.com' }],
    ]) {
      res = await request(method, route, { token, body });
      check(res.status === 403 && /turned off in the demo/.test(res.body?.error), `${method} ${route} is refused`, `${res.status}`);
    }
    res = await request('PUT', '/api/settings/auto-hold', { token, body: { enabled: false } });
    check(res.status === 200, 'but its own settings can change (auto-hold)', String(res.status));
    res = await request('PUT', `/api/decisions/${wrong.id}/feedback`, { token, body: { feedback: 'up', note: null } });
    check(res.status === 200 && res.body.feedback === 'up', 'and decisions can be rated');
    res = await request('POST', '/api/orders/sync', { token });
    check(res.status === 200 && /demo store/.test(res.body?.message), 'syncing says there is nothing to sync', res.body?.message);
    res = await request('POST', '/api/inventory/sync', { token });
    check(res.status === 200 && /demo store/.test(res.body?.message), 'for stock too');
    const ran = await runAgent(sellerId, { type: 'order_created', order: { id: 5500001, name: '#1001', line_items: [] } });
    check(ran === null && modelCalls === 0, 'the agent never runs for a demo, so no model call', `calls: ${modelCalls}`);
    res = await request('POST', '/api/auth/login', { body: { email: settings.email, password: 'anything' } });
    check(res.status === 401, "a demo account can't be signed in to with a password", String(res.status));

    console.log('\n4. Expiry, the cap, turning it off');
    const second = await startDemo();
    check(second.status === 201 && second.body.sellerId !== sellerId, 'each visitor gets their own');
    await pool.query('UPDATE sellers SET demo_expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [sellerId]);
    const removed = await demo.removeExpiredDemos();
    const [[gone]] = await pool.query('SELECT COUNT(*) AS n FROM sellers WHERE id = ?', [sellerId]);
    const [[leftovers]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM orders WHERE seller_id = ?) + (SELECT COUNT(*) FROM decisions WHERE seller_id = ?) + (SELECT COUNT(*) FROM inventory_items WHERE seller_id = ?) AS n`,
      [sellerId, sellerId, sellerId]
    );
    check(removed >= 1 && gone.n === 0 && leftovers.n === 0, 'an expired demo is removed, with everything in it', `${removed} removed, ${leftovers.n} rows left`);
    res = await request('GET', '/api/settings', { token });
    check(res.status === 401, 'and its session stops working', String(res.status));
    const [[{ active }]] = await pool.query('SELECT COUNT(*) AS active FROM sellers WHERE is_demo = TRUE');
    process.env.DEMO_MAX_ACTIVE = String(Number(active));
    res = await startDemo();
    check(res.status === 503 && /busy/.test(res.body?.error), 'at the cap: "the demo is busy"', res.body?.error);
    delete process.env.DEMO_MAX_ACTIVE;
    process.env.DEMO_ENABLED = 'false';
    res = await startDemo();
    const cfg = await request('GET', '/api/auth/config');
    check(res.status === 404 && cfg.body?.demo_available === false, 'DEMO_ENABLED=false turns it off', String(res.status));
    delete process.env.DEMO_ENABLED;
    check(shopifyCalls === 0, 'nothing called Shopify', String(shopifyCalls));
  } finally {
    server.close();
    llm.close();
    if (made.length) {
      await pool.query('UPDATE sellers SET demo_expires_at = NOW() - INTERVAL 1 MINUTE WHERE id IN (?) AND is_demo = TRUE', [made]);
      await require('../src/services/demo').removeExpiredDemos();
    }
    console.log('\nRemoved the demo accounts made here.');
    await pool.end();
  }
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.stack || err.message}`);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
  });
