const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { getForecast } = require('./restockForecast');

// "Try the demo": each visitor gets an account of their own with a sample
// store (made-up products, orders, fraud checks and agent decisions), so the
// dashboard can be tried without signing up or connecting a real store.
//
// A demo account has no Shopify store and no password. Its "Shopify" is
// demoStore.js, worked out from its own tables, so holding and fulfilling
// work without a real store. Nothing in it can reach outside: the agent never
// runs for it (no model calls), and connecting a store, alert channels, API
// keys and "send now" are refused (middleware/notInDemo.js). Each account is
// removed once it expires; a cap limits how many exist at once.
//
//   DEMO_ENABLED=false     turns "Try the demo" off (on by default)
//   DEMO_HOURS=4           how long a demo account lasts
//   DEMO_MAX_ACTIVE=200    how many can exist at once

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function isDemoEnabled() {
  return process.env.DEMO_ENABLED !== 'false';
}
function demoHours() {
  const hours = Number(process.env.DEMO_HOURS);
  return hours > 0 && hours <= 48 ? hours : 4;
}
function maxActive() {
  const max = Number(process.env.DEMO_MAX_ACTIVE);
  return Number.isInteger(max) && max > 0 ? max : 200;
}

class DemoUnavailableError extends Error {}

// --- The sample store ---

const PRODUCTS = [
  { key: 'scarf', name: 'Linen Scarf', price: 34, stock: 2, threshold: 5, weight: 5 },
  { key: 'mug', name: 'Ceramic Mug', price: 18, stock: 14, threshold: 6, weight: 6 },
  { key: 'candle', name: 'Beeswax Candle', price: 22, stock: 0, threshold: 4, weight: 4 },
  { key: 'tote', name: 'Canvas Tote', price: 26, stock: 42, threshold: 8, weight: 4 },
  { key: 'throw', name: 'Wool Throw', price: 89, stock: 7, threshold: 3, weight: 2 },
  { key: 'pins', name: 'Enamel Pin Set', price: 12, stock: 60, threshold: 10, weight: 3 },
  { key: 'notebook', name: 'Recycled Notebook', price: 9.5, stock: 9, threshold: 10, weight: 4 },
  { key: 'bookmark', name: 'Brass Bookmark', price: 14, stock: 25, threshold: 5, weight: 2 },
];
const BUYERS = [
  'Maya Chen', 'Luis Ortega', 'Priya Nair', 'Tom Becker', 'Aiko Tanaka', 'Sam Wilson', 'Nora Lindqvist', 'Omar Haddad',
  'Grace Kim', 'Leo Rossi', 'Zoe Martin', 'Ravi Patel', 'Emma Dubois', 'Jonas Weber', 'Ana Souza', 'Ben Carter',
];

// The same sample store every time: a small seeded random generator.
function generator(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const variantId = (product) => String(9100001 + PRODUCTS.indexOf(product));
const byKey = (key) => PRODUCTS.find((p) => p.key === key);
const money = (n) => (Math.round(n * 100) / 100).toFixed(2);

// Orders for the last 30 days, oldest first. The recent ones are the ones
// the tour is about: a high fraud risk the agent put on hold, a payment
// pending, an item out of stock, a medium fraud risk, one ready to ship and
// one shipping late.
function sampleOrders(nowMs) {
  const rng = generator(20260927);
  const pick = () => {
    const total = PRODUCTS.reduce((sum, p) => sum + p.weight, 0);
    let r = rng() * total;
    return PRODUCTS.find((p) => (r -= p.weight) < 0) || PRODUCTS[0];
  };
  const orders = [];
  for (let day = 29; day >= 3; day--) {
    const count = rng() < 0.45 ? 1 : 2;
    for (let i = 0; i < count; i++) {
      const lines = [];
      const kinds = rng() < 0.7 ? 1 : 2;
      for (let k = 0; k < kinds; k++) {
        const product = pick();
        if (!lines.some((l) => l.product === product)) lines.push({ product, quantity: rng() < 0.75 ? 1 : 2 });
      }
      orders.push({ placedMs: nowMs - day * DAY - Math.floor(rng() * 20) * HOUR, lines, status: 'fulfilled', payment: 'paid', kind: 'past' });
    }
  }
  orders[8].payment = 'refunded';
  orders[20].kind = 'held-and-shipped'; // put on hold by the seller, then released and shipped
  // Last week's flagged one (shipped after a check), for the Overview's comparison.
  const lastWeek = orders.find((o) => nowMs - o.placedMs > 9 * DAY && nowMs - o.placedMs < 13 * DAY && o.payment === 'paid');
  lastWeek.risk = { level: 'medium', recommendation: 'investigate', reasons: ['The order was placed through a proxy'], matches: true };

  const recent = (hoursAgo, kind, lines, extra = {}) => ({
    placedMs: nowMs - hoursAgo * HOUR,
    lines: lines.map(([key, quantity]) => ({ product: byKey(key), quantity })),
    status: 'unfulfilled',
    payment: 'paid',
    kind,
    ...extra,
  });
  orders.push(
    recent(50, 'late', [['mug', 2]]),
    recent(26, 'medium-risk', [['bookmark', 3], ['pins', 1]], {
      risk: { level: 'medium', recommendation: 'investigate', reasons: ['The shipping address is a freight forwarder'], matches: false },
    }),
    recent(20, 'ready', [['tote', 1], ['notebook', 2]]),
    recent(8, 'out-of-stock', [['candle', 2], ['tote', 1]]),
    recent(5, 'pending', [['mug', 4]], { payment: 'pending' }),
    recent(2, 'high-risk', [['throw', 2]], {
      risk: {
        level: 'high',
        recommendation: 'cancel',
        reasons: ['The card was declined 4 times before it was accepted', "The billing country differs from the IP address's country"],
        matches: false,
      },
    })
  );
  orders.forEach((order, i) => {
    order.number = `#${1001 + i}`;
    order.buyer = i % 9 === 5 ? null : BUYERS[i % BUYERS.length]; // a few with the name held back, as Shopify does
    order.total = order.lines.reduce((sum, l) => sum + l.product.price * l.quantity, 0) + 6; // + shipping
  });
  return orders;
}

// Stock left after each order's items, as the agent's stock check saw it:
// today's stock plus everything sold in later orders.
function stockAfter(orders, order, product) {
  const later = orders
    .filter((o) => o.placedMs > order.placedMs && o.payment !== 'refunded')
    .reduce((sum, o) => sum + (o.lines.find((l) => l.product === product)?.quantity ?? 0), 0);
  return product.stock + later;
}

function reasoningFor(orders, order) {
  const items = order.lines.map((l) => `- ${l.product.name} (×${l.quantity}): ${stockAfter(orders, order, l.product)} left after this order, can ship now.`);
  switch (order.kind) {
    case 'high-risk':
      return [
        `HOLD — High fraud risk on ${order.number}: review it before shipping.`,
        '',
        "- Shopify's fraud check: high risk, recommends cancelling.",
        '- The card was declined 4 times before it went through, and the billing and shipping addresses differ.',
        `- Stock is fine (Wool Throw: ${stockAfter(orders, order, byKey('throw'))} left), so the only question is the payment.`,
        '- Check it in Shopify, and cancel or contact the buyer before shipping.',
      ].join('\n');
    case 'pending':
      return [
        `HOLD — ${order.number} is waiting on payment.`,
        '',
        '- Payment status is pending (bank transfer), so it isn\'t paid yet.',
        `- Ceramic Mug (×4): ${stockAfter(orders, order, byKey('mug'))} left after this order, can ship once paid.`,
        "- Shopify's fraud check: low risk.",
      ].join('\n');
    case 'out-of-stock':
      return [
        `HOLD — ${order.number} can't ship: Beeswax Candle is out of stock.`,
        '',
        '- Beeswax Candle (×2): 0 on hand, 2 short.',
        `- Canvas Tote (×1): ${stockAfter(orders, order, byKey('tote'))} left after this order, can ship.`,
        '- Restock the candles, then fulfill; or ship the tote now and the candles later.',
      ].join('\n');
    case 'medium-risk':
      return [
        `HOLD — ${order.number}: Shopify suggests checking this order first.`,
        '',
        "- Shopify's fraud check: medium risk, recommends investigating (the shipping address is a freight forwarder).",
        "- The billing and shipping addresses don't match.",
        ...items,
        '- Confirm with the buyer before shipping.',
      ].join('\n');
    default:
      return [
        `FULFILL — ${order.number} is paid and every item is in stock.`,
        '',
        ...items,
        "- Shopify's fraud check: low risk.",
      ].join('\n');
  }
}

// How the seller rated the calls: most right, the pending bank transfer
// wrong (with the note the agent now learns from), the newest not yet.
function ratingFor(order, index) {
  if (order.kind === 'pending') return ['down', 'Bank transfers always show as pending at first and clear within a day: ship them.'];
  if (['high-risk', 'out-of-stock', 'ready'].includes(order.kind)) return [null, null];
  if (order.kind === 'medium-risk') return ['up', 'Right: freight forwarders are worth a check.'];
  return index % 3 === 2 ? [null, null] : ['up', null];
}

const at = (ms) => new Date(ms);

async function seedDemoStore(conn, sellerId, nowMs) {
  const orders = sampleOrders(nowMs);

  await conn.query(
    `INSERT INTO inventory_items (seller_id, shopify_product_id, shopify_variant_id, item_name, stock_quantity, low_stock_threshold, synced_at) VALUES ?`,
    [PRODUCTS.map((p) => [sellerId, String(8100001 + PRODUCTS.indexOf(p)), variantId(p), p.name, p.stock, p.threshold, at(nowMs)])]
  );

  for (const [i, order] of orders.entries()) {
    const risk = order.risk || { level: 'low', recommendation: 'accept', reasons: [], matches: true };
    const [result] = await conn.query(
      `INSERT INTO orders (seller_id, shopify_order_id, order_number, status, financial_status, buyer_name, total_amount, order_placed_at,
         synced_at, line_items_synced_at, risk_level, risk_recommendation, risk_reasons, billing_matches_shipping, risk_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sellerId,
        String(5500001 + i),
        order.number,
        order.status,
        order.payment,
        order.buyer,
        money(order.total),
        at(order.placedMs),
        at(nowMs),
        at(nowMs),
        risk.level,
        risk.recommendation,
        JSON.stringify(risk.reasons),
        risk.matches,
        at(order.placedMs + 60 * 1000),
      ]
    );
    order.id = result.insertId;
    await conn.query(
      `INSERT INTO order_line_items (order_id, shopify_line_item_id, shopify_variant_id, title, variant_title, sku, quantity, fulfillable_quantity, price) VALUES ?`,
      [
        order.lines.map((l, n) => [
          order.id,
          String(7700001 + i * 10 + n),
          variantId(l.product),
          l.product.name,
          null,
          `DEMO-${l.product.key.toUpperCase()}`,
          l.quantity,
          order.status === 'fulfilled' ? 0 : l.quantity,
          money(l.product.price),
        ]),
      ]
    );

    if (order.payment === 'refunded') continue; // cancelled before the agent's call mattered
    const decidedMs = order.placedMs + 90 * 1000;
    const [feedback, note] = ratingFor(order, i);
    const reasoning = reasoningFor(orders, order);
    await conn.query(
      `INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken, created_at, feedback, feedback_note, feedback_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sellerId, order.id, order.number, reasoning, reasoning.startsWith('HOLD') ? 'hold' : 'fulfill', at(decidedMs), feedback, note, feedback ? at(decidedMs + 3 * HOUR) : null]
    );

    const act = (action, source, minutesAfter, extra = {}) =>
      conn.query(
        `INSERT INTO order_actions (seller_id, order_id, action, source, fulfillment_order_id, reason, note, ok, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
        [sellerId, order.id, action, source, String(order.id), extra.reason ?? null, extra.note ?? null, at(order.placedMs + minutesAfter * 60 * 1000)]
      );
    if (order.kind === 'high-risk') {
      // Auto-hold was on: the agent's HOLD put it on hold in "Shopify".
      await act('hold', 'agent', 2, { reason: 'HIGH_RISK_OF_FRAUD', note: `High fraud risk on ${order.number}: review it before shipping.` });
    } else if (order.kind === 'held-and-shipped') {
      await act('hold', 'seller', 40, { reason: 'INCORRECT_ADDRESS', note: 'Waiting for the buyer to confirm the flat number' });
      await act('release', 'seller', 300);
      await act('fulfill', 'seller', 310, { note: '1Z999AA10123456784' });
    }
  }
  return { orders: orders.length, items: PRODUCTS.length };
}

// The agent's low-stock calls, with the forecast worked out from the sample
// orders (so after they're committed: the forecast reads through the pool).
async function seedLowStockCalls(sellerId, nowMs) {
  const forecast = await getForecast(sellerId, { variantIds: [variantId(byKey('scarf')), variantId(byKey('notebook'))] }, nowMs);
  const restock = (item) => {
    const f = forecast.items.find((x) => x.item_name === item.name);
    if (!f) return null;
    const pace = f.per_day >= 1 ? `${Math.round(f.per_day * 10) / 10} a day` : `about ${Math.max(1, Math.round(f.per_day * 7))} a week`;
    return [
      `RESTOCK — ${item.name} is running low.`,
      '',
      `- ${item.name}: ${item.stock} left, at or below its level of ${item.threshold}.`,
      `- It sells ${pace} (last ${Math.round(forecast.history.days)} days, ${f.orders} orders), so it runs out in about ${Math.max(1, Math.round(f.days_left))} days.`,
      `- Reorder ${f.reorder_quantity} to last ${forecast.cover_days} days.`,
    ].join('\n');
  };
  const lowStockCalls = [
    [byKey('scarf'), 6 * HOUR, null],
    [byKey('notebook'), 30 * HOUR, 'up'],
  ];
  for (const [item, ago, feedback] of lowStockCalls) {
    const reasoning = restock(item);
    if (!reasoning) continue;
    await pool.query(
      `INSERT INTO decisions (seller_id, reasoning, action_taken, created_at, feedback, feedback_at) VALUES (?, ?, 'low_stock_alert', ?, ?, ?)`,
      [sellerId, reasoning, at(nowMs - ago), feedback, feedback ? at(nowMs - ago + HOUR) : null]
    );
  }
}

// --- Accounts ---

// A new demo account with its sample store. Returns { sellerId, businessName, expiresAt }.
// Throws DemoUnavailableError when the demo is off or full.
async function createDemoAccount(nowMs = Date.now()) {
  if (!isDemoEnabled()) throw new DemoUnavailableError('The demo is turned off.');
  await removeExpiredDemos();
  const [[{ active }]] = await pool.query('SELECT COUNT(*) AS active FROM sellers WHERE is_demo = TRUE');
  if (Number(active) >= maxActive()) throw new DemoUnavailableError('The demo is busy right now. Try again in a little while.');

  const expiresAt = new Date(nowMs + demoHours() * HOUR);
  // No one signs in to it with a password: the hash is of a random secret nobody keeps.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO sellers (business_name, email, password_hash, is_demo, demo_expires_at, timezone, auto_hold)
       VALUES ('Demo Store', ?, ?, TRUE, ?, 'UTC', TRUE)`,
      [`demo-${crypto.randomBytes(8).toString('hex')}@demo.invalid`, passwordHash, expiresAt]
    );
    const sellerId = result.insertId;
    await seedDemoStore(conn, sellerId, nowMs);
    await conn.commit();
    await seedLowStockCalls(sellerId, nowMs);
    return { sellerId, businessName: 'Demo Store', expiresAt };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Removes demo accounts whose time is up, with everything in them. Returns how many.
async function removeExpiredDemos() {
  const [rows] = await pool.query('SELECT id FROM sellers WHERE is_demo = TRUE AND demo_expires_at < NOW()');
  const ids = rows.map((r) => r.id);
  if (!ids.length) return 0;
  for (const table of ['decisions', 'orders', 'inventory_items', 'customer_messages', 'api_keys']) {
    await pool.query(`DELETE FROM ${table} WHERE seller_id IN (?)`, [ids]); // line items and actions go with the orders
  }
  await pool.query('DELETE FROM sellers WHERE id IN (?) AND is_demo = TRUE', [ids]);
  return ids.length;
}

async function isDemoSeller(sellerId) {
  const [[row]] = await pool.query('SELECT is_demo FROM sellers WHERE id = ?', [sellerId]);
  return Boolean(row?.is_demo);
}

// Clears out expired demo accounts every 15 minutes.
function startDemoCleanup() {
  const tick = () =>
    removeExpiredDemos()
      .then((n) => n && console.log(`[demo] removed ${n} expired demo account(s)`))
      .catch((err) => console.error(`[demo] cleanup failed: ${err.message}`));
  tick();
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = {
  isDemoEnabled,
  demoHours,
  DemoUnavailableError,
  createDemoAccount,
  removeExpiredDemos,
  isDemoSeller,
  startDemoCleanup,
  sampleOrders,
  PRODUCTS,
};
