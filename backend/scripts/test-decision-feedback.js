// End-to-end check of thumbs up/down on agent decisions, run in-process
// against the real database with throwaway sellers (removed at the end):
//   1. rating a decision up or down, with a note, changing it and clearing it
//   2. the ratings on the decisions feed, an order's page and the Overview
//   3. bad input, skipped runs, other sellers' decisions, signed out
//   4. privacy: a customer's name is scrubbed from notes, and notes are in
//      data requests
//
// Usage:  npm run test:decision-feedback
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../src/config/secrets');
  const { upsertOrder } = require('../src/models/orderModel');
  const { customerData, redactCustomer } = require('../src/models/privacyModel');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];

  const addSeller = async (name) => {
    const [r] = await pool.query("INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, 'x')", [
      name,
      `fb-${run}-${name}@example.test`,
    ]);
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  const addDecision = async (sellerId, action, { orderId = null, daysBack = 0 } = {}) => {
    const [r] = await pool.query(
      "INSERT INTO decisions (seller_id, order_id, reasoning, action_taken, created_at) VALUES (?, ?, 'test', ?, NOW() - INTERVAL ? MINUTE)",
      [sellerId, orderId, action, Math.round(daysBack * 24 * 60)]
    );
    return r.insertId;
  };
  const call = async (method, route, sellerId, body) => {
    const headers = sellerId ? { Authorization: `Bearer ${jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' })}` } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const rate = (sellerId, id, body) => call('PUT', `/api/decisions/${id}/feedback`, sellerId, body);
  const stored = async (id) => (await pool.query('SELECT feedback, feedback_note, feedback_at FROM decisions WHERE id = ?', [id]))[0][0];

  try {
    const seller = await addSeller('main');
    const orderId = await upsertOrder(seller, {
      id: 770001,
      name: '#770001',
      fulfillment_status: null,
      financial_status: 'paid',
      customer: { first_name: 'Maria', last_name: 'Santos' },
      total_price: '25.00',
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      line_items: [],
    });
    const fulfill = await addDecision(seller, 'fulfill', { orderId, daysBack: 1 });
    const hold = await addDecision(seller, 'hold', { orderId, daysBack: 0.5 });
    const restock = await addDecision(seller, 'low_stock_alert', { daysBack: 2 });
    const skipped = await addDecision(seller, 'skipped', { daysBack: 1 });
    const old = await addDecision(seller, 'fulfill', { daysBack: 20 }); // before the Overview's 7 days

    console.log('\n1. Rating a decision');
    let res = await rate(seller, fulfill, { feedback: 'up' });
    check(res.status === 200 && res.body.id === fulfill && res.body.feedback === 'up' && res.body.feedback_note === null && res.body.feedback_at, 'thumbs up is saved', JSON.stringify(res.body));
    res = await rate(seller, hold, { feedback: 'down', note: '  Should have fulfilled: the address was fine.  ' });
    check(res.status === 200 && res.body.feedback === 'down' && res.body.feedback_note === 'Should have fulfilled: the address was fine.', 'thumbs down with a note (trimmed)', JSON.stringify(res.body));
    res = await rate(seller, restock, { feedback: 'down' });
    res = await rate(seller, restock, { feedback: 'up', note: 'Right, reordered.' });
    let row = await stored(restock);
    check(res.status === 200 && row.feedback === 'up' && row.feedback_note === 'Right, reordered.', 'changing the rating replaces it', JSON.stringify(row));
    res = await rate(seller, restock, { feedback: 'up', note: '' });
    row = await stored(restock);
    check(res.status === 200 && row.feedback === 'up' && row.feedback_note === null, 'an empty note removes the note, keeps the rating', JSON.stringify(row));
    res = await rate(seller, old, { feedback: 'down', note: 'kept?' });
    res = await rate(seller, old, { feedback: null });
    row = await stored(old);
    check(res.status === 200 && row.feedback === null && row.feedback_note === null && row.feedback_at === null, 'null clears the rating and its note', JSON.stringify(row));
    await rate(seller, old, { feedback: 'down' });

    console.log('\n2. Where ratings show up');
    res = await call('GET', '/api/decisions', seller);
    const byId = new Map((res.body?.decisions || []).map((d) => [d.id, d]));
    check(byId.get(hold)?.feedback === 'down' && byId.get(hold).feedback_note.startsWith('Should have') && byId.get(skipped)?.feedback === null, 'the decisions feed has each rating and note', JSON.stringify(byId.get(hold)));
    const ratings = res.body?.ratings;
    check(
      ratings?.up === 2 && ratings.down === 2 && ratings.unrated === 0,
      'and the ratings over every decision, skipped left out (2 up, 2 down)',
      JSON.stringify(ratings && { up: ratings.up, down: ratings.down, unrated: ratings.unrated })
    );
    check(
      JSON.stringify(ratings?.by_verdict) ===
        JSON.stringify({ fulfill: { up: 1, down: 1, unrated: 0 }, hold: { up: 0, down: 1, unrated: 0 }, low_stock_alert: { up: 1, down: 0, unrated: 0 }, unknown: { up: 0, down: 0, unrated: 0 } }),
      'per verdict',
      JSON.stringify(ratings?.by_verdict)
    );
    res = await call('GET', `/api/orders/${orderId}`, seller);
    const onOrder = res.body?.decisions || [];
    check(onOrder.length === 2 && onOrder[0].id === hold && onOrder[0].feedback === 'down' && onOrder[1].feedback === 'up', 'the order\'s page has the ratings of its decisions', JSON.stringify(onOrder.map((d) => [d.id, d.feedback])));
    res = await call('GET', '/api/overview', seller);
    const r = res.body?.decisions?.ratings;
    check(res.status === 200 && r?.up === 2 && r.down === 1 && r.unrated === 0, 'the Overview counts ratings of this period\'s decisions only', JSON.stringify(r && { up: r.up, down: r.down, unrated: r.unrated }));
    check(res.body?.decisions?.total === 4 && res.body.decisions.skipped === 1, 'next to the counts by verdict', JSON.stringify(res.body?.decisions));

    console.log('\n3. What\'s refused');
    for (const [body, pattern] of [
      [{ feedback: 'sideways' }, /feedback must be/],
      [{}, /feedback must be/],
      [{ feedback: 'down', note: 5 }, /note must be text/],
      [{ feedback: 'down', note: 'x'.repeat(501) }, /at most 500/],
    ]) {
      res = await rate(seller, fulfill, body);
      check(res.status === 400 && pattern.test(res.body?.error), `${JSON.stringify(body).slice(0, 40)}: 400`, res.body?.error);
    }
    check((await stored(fulfill)).feedback === 'up', 'and the rating stays as it was');
    res = await rate(seller, skipped, { feedback: 'up' });
    check(res.status === 400 && /skipped run/.test(res.body?.error) && (await stored(skipped)).feedback === null, 'a skipped run can\'t be rated', res.body?.error);
    for (const id of ['999999999', 'abc', '0', '1.5']) {
      res = await rate(seller, id, { feedback: 'up' });
      check(res.status === 404, `decision ${id}: 404`, String(res.status));
    }
    const other = await addSeller('other');
    res = await rate(other, hold, { feedback: 'up' });
    check(res.status === 404 && (await stored(hold)).feedback === 'down', 'another seller can\'t rate this seller\'s decision', String(res.status));
    res = await call('GET', '/api/decisions', other);
    check(res.body?.decisions?.length === 0 && res.body.ratings.up === 0 && res.body.ratings.down === 0, 'or see its ratings');
    res = await rate(null, hold, { feedback: 'up' });
    check(res.status === 401, 'signed out: 401', String(res.status));

    console.log('\n4. Privacy');
    await rate(seller, hold, { feedback: 'down', note: 'Maria Santos always pays, no need to hold' });
    const data = await customerData(seller, ['770001']);
    check(data.decisions.some((d) => d.feedback_note === 'Maria Santos always pays, no need to hold'), 'a data request includes the seller\'s notes on that order', JSON.stringify(data.decisions.map((d) => d.feedback_note)));
    await redactCustomer(seller, ['770001']);
    row = await stored(hold);
    check(row.feedback_note === '[redacted] always pays, no need to hold' && row.feedback === 'down', 'customers/redact scrubs the name from notes, keeps the rating', row.feedback_note);
  } finally {
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]);
    }
    console.log('\nRemoved the test sellers and their orders and decisions.');
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
