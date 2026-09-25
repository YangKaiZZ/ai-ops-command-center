// End-to-end check of the daily summary, late-order alerts and rating
// decisions from alerts, run in-process against a fake SMTP server and a
// fake Telegram API on localhost (nothing is really sent; the real database
// is used with throwaway sellers, removed at the end):
//   1. report settings through the API: defaults, bad values, saving,
//      "Send one now"
//   2. the daily summary: queued when due, sent through the job queue to
//      email and Telegram with yesterday's numbers, once a day
//   3. late-order alerts: only paid orders past the hours, each named once
//   4. rating from alerts: links in email, the rating page's API (signed,
//      one decision, expiring), and one-tap buttons plus a note by reply in
//      Telegram, only from the seller's own chat
//
// Usage:  npm run test:reports
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const net = require('net');
const http = require('http');
const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(50);
  }
  return null;
}

// --- a fake SMTP server: accepts every message and keeps it ---
function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    let to = [];
    socket.write('220 fake-smtp ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ to, raw: data });
            data = '';
            socket.write('250 queued\r\n');
          } else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-fake-smtp\r\n250 8BITMIME\r\n');
        else if (cmd === 'HELO' || cmd === 'RSET' || cmd === 'NOOP') socket.write('250 ok\r\n');
        else if (cmd === 'MAIL') {
          to = [];
          socket.write('250 ok\r\n');
        } else if (cmd === 'RCPT') {
          to.push(line.match(/<([^>]+)>/)?.[1]);
          socket.write('250 ok\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.address().port })));
}

// The text of a fake-SMTP message: headers dropped, quoted-printable soft breaks joined.
const mailBody = (m) => m.raw.split('\n\n').slice(1).join('\n\n').replace(/=\n/g, '').replace(/=3D/g, '=');
const mailSubject = (m) => m.raw.match(/^Subject: (.*)$/m)?.[1] || '';

// --- a fake Telegram Bot API: records every call, serves getUpdates from a queue ---
function startFakeTelegram() {
  const queue = [];
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      const params = body ? JSON.parse(body) : {};
      let result = true;
      if (method === 'getMe') result = { id: 1, is_bot: true, username: 'aiops_test_bot' };
      else if (method === 'getUpdates') {
        for (let i = 0; i < 6 && !queue.length; i++) await wait(50);
        result = queue.splice(0).filter((u) => u.update_id >= (params.offset || 0));
      } else {
        calls.push({ method, params });
        if (method === 'sendMessage') result = { message_id: 1000 + calls.length };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, queue, calls, port: server.address().port })));
}

async function main() {
  const smtp = await startFakeSmtp();
  const tg = await startFakeTelegram();
  Object.assign(process.env, {
    SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
    EMAIL_FROM: 'AI Ops <alerts@example.test>',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_API_BASE: `http://127.0.0.1:${tg.port}`,
    DASHBOARD_URL: 'https://ops.example.test',
    JOB_RETRY_BASE_SECONDS: '0',
  });

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../src/config/secrets');
  const { upsertOrder } = require('../src/models/orderModel');
  const queue = require('../src/services/jobQueue');
  require('../src/services/jobHandlers');
  const { queueDueReports } = require('../src/services/reports');
  const { postDecision } = require('../src/services/notifier');
  const { ratingToken } = require('../src/services/ratingLinks');
  const telegram = require('../src/services/telegram');
  const { localDate, addDays, startOfDay, localParts } = require('../src/utils/timeZone');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, route, sellerId, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (sellerId) headers.Authorization = `Bearer ${jwt.sign({ sellerId }, JWT_SECRET, { expiresIn: '10m' })}`;
    const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];
  const addSeller = async (name, fields = {}) => {
    const [r] = await pool.query("INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, 'x')", [name, `reports-${run}-${sellerIds.length}@example.test`]);
    sellerIds.push(r.insertId);
    for (const [column, value] of Object.entries(fields)) await pool.query(`UPDATE sellers SET ${column} = ? WHERE id = ?`, [value, r.insertId]);
    return r.insertId;
  };
  const sellerRow = async (id) => (await pool.query("SELECT DATE_FORMAT(summary_sent_on, '%Y-%m-%d') AS sent_on FROM sellers WHERE id = ?", [id]))[0][0];
  const jobsOf = async (id) => (await pool.query('SELECT id, type, status, dedupe_key, last_error FROM jobs WHERE seller_id = ? ORDER BY id', [id]))[0];
  const allDone = (id) => until(async () => (await jobsOf(id)).every((j) => j.status === 'done' || j.status === 'failed'));
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  let nextOrder = 1;
  const seeded = []; // the main seller's orders, to work out what the summary should say
  const order = (sellerId, placedMs, fulfillment, payment, total = '10.00') => {
    const n = nextOrder++;
    if (sellerIds.indexOf(sellerId) === 0) seeded.push({ placedMs, payment, total: Number(total) });
    return upsertOrder(sellerId, {
      id: Number(`77${n}${Date.now() % 100000}`),
      name: `#R${n}`,
      fulfillment_status: fulfillment,
      financial_status: payment,
      customer: null,
      total_price: total,
      created_at: iso(placedMs),
      line_items: [],
    });
  };
  const HOUR = 3600 * 1000;
  const zone = 'Asia/Manila';

  try {
    const seller = await addSeller('Report Shop', { alert_email: `owner-${run}@example.test`, telegram_chat_id: '4242' });
    const fresh = await addSeller('Fresh Shop');
    telegram.startTelegramPolling();

    console.log('\n1. Settings');
    let res = await call('GET', '/api/settings', fresh);
    check(
      JSON.stringify(res.json?.reports) === JSON.stringify({ timezone: null, summary: { enabled: false, hour: 8 }, late_orders: { enabled: false, after_hours: 24 } }),
      'both reports are off by default',
      JSON.stringify(res.json?.reports)
    );
    res = await call('PUT', '/api/settings/reports', fresh, { timezone: 'Mars/Olympus', summary: { enabled: true, hour: 8 }, late_orders: { enabled: false, after_hours: 24 } });
    check(res.status === 400 && /time zone/.test(res.json?.error), 'an unknown time zone is refused', res.json?.error);
    res = await call('PUT', '/api/settings/reports', fresh, { timezone: zone, summary: { enabled: true, hour: 8 }, late_orders: { enabled: true, after_hours: 36 } });
    check(res.status === 400 && /12, 24, 48, 72/.test(res.json?.error), 'late-order hours outside 12, 24, 48, 72 are refused');
    const localHour = localParts(new Date(), zone).hour;
    const today = localDate(new Date(), zone);
    res = await call('PUT', '/api/settings/reports', fresh, { timezone: zone, summary: { enabled: true, hour: 0 }, late_orders: { enabled: true, after_hours: 48 } });
    check(res.status === 200 && res.json.reports.summary.enabled && res.json.reports.late_orders.after_hours === 48 && res.json.reports.timezone === zone, 'saved', JSON.stringify(res.json?.reports));
    check((await sellerRow(fresh)).sent_on === today, "turned on after its hour: today's counts as done, so the first comes tomorrow");
    if (localHour < 23) {
      await pool.query('UPDATE sellers SET summary_sent_on = NULL WHERE id = ?', [fresh]);
      await call('PUT', '/api/settings/reports', fresh, { timezone: zone, summary: { enabled: true, hour: localHour + 1 }, late_orders: { enabled: false, after_hours: 24 } });
      check((await sellerRow(fresh)).sent_on === null, 'turned on before its hour: it still comes today');
    }
    res = await call('POST', '/api/settings/reports/summary', fresh);
    check(res.status === 400 && /alert channel/.test(res.json?.error), '"Send one now" with no channels asks for one');
    await pool.query('UPDATE sellers SET summary_enabled = FALSE, late_alerts_enabled = FALSE WHERE id = ?', [fresh]);

    // The main seller's data, placed relative to its local days.
    const yesterday = addDays(today, -1);
    const dayStart = startOfDay(yesterday, zone).getTime();
    await order(seller, dayStart + 2 * HOUR, 'fulfilled', 'paid', '100.00');
    await order(seller, dayStart + 5 * HOUR, 'fulfilled', 'paid', '50.50');
    await order(seller, dayStart + 6 * HOUR, 'fulfilled', 'refunded', '999.00'); // counted, no sales
    await order(seller, startOfDay(addDays(today, -2), zone).getTime() + 3 * HOUR, 'fulfilled', 'paid', '40.00'); // the day before
    const now = Date.now();
    const lateId = await order(seller, now - 30 * HOUR, null, 'paid', '58.00'); // late
    await order(seller, now - 40 * HOUR, null, 'pending', '20.00'); // payment pending: not late
    await order(seller, now - 10 * HOUR, null, 'paid', '15.00'); // not late yet
    await order(seller, now - 20 * 24 * HOUR, null, 'paid', '12.00'); // late long ago: in the summary, not alerted
    await pool.query(
      "INSERT INTO inventory_items (seller_id, shopify_product_id, shopify_variant_id, item_name, stock_quantity, low_stock_threshold) VALUES (?, '1', '1', 'Linen Scarf', 0, 5)",
      [seller]
    );
    await pool.query(
      `INSERT INTO decisions (seller_id, order_number, reasoning, action_taken, created_at, feedback) VALUES
       (?, '#R1', 'FULFILL - ok', 'fulfill', FROM_UNIXTIME(?), 'up'), (?, '#R2', 'HOLD - x', 'hold', FROM_UNIXTIME(?), 'down'), (?, '#R3', 'FULFILL - y', 'fulfill', FROM_UNIXTIME(?), NULL)`,
      [seller, Math.floor((dayStart + 3 * HOUR) / 1000), seller, Math.floor((dayStart + 4 * HOUR) / 1000), seller, Math.floor((dayStart + 7 * HOUR) / 1000)]
    );

    console.log('\n2. The daily summary');
    await call('PUT', '/api/settings/reports', seller, { timezone: zone, summary: { enabled: true, hour: 0 }, late_orders: { enabled: false, after_hours: 24 } });
    await pool.query('UPDATE sellers SET summary_sent_on = NULL WHERE id = ?', [seller]); // as if it was on before today
    let queued = await queueDueReports();
    const summaryJob = (await jobsOf(seller)).find((j) => j.type === 'daily_summary');
    check(queued.summaries >= 1 && summaryJob?.dedupe_key === `summary:${seller}:${today}`, "queued once it's due, keyed to the local day", summaryJob?.dedupe_key);
    check((await queueDueReports()).summaries === 0, 'a second check queues nothing while it waits');
    const mailsBefore = smtp.messages.length;
    await queue.startWorker({ concurrency: 1 });
    await allDone(seller);
    const summaryMail = await until(() => smtp.messages.slice(mailsBefore).find((m) => /Daily summary for Report Shop/.test(mailSubject(m))));
    const body = summaryMail ? mailBody(summaryMail) : '';
    check(Boolean(summaryMail) && !body.includes('*'), 'emailed, as plain text', mailSubject(summaryMail || { raw: '' }));
    // Orders placed relative to now can land in yesterday too, depending on the time of day.
    const todayStart = startOfDay(today, zone).getTime();
    const prevStart = startOfDay(addDays(today, -2), zone).getTime();
    const inDay = (from, to) => seeded.filter((o) => o.placedMs >= from && o.placedMs < to);
    const sales = (list) => list.filter((o) => !['refunded', 'voided'].includes(o.payment)).reduce((sum, o) => sum + o.total, 0);
    const expectDay = inDay(dayStart, todayStart);
    const ordersLine = body.match(/- Orders: (\d+), .*?\. Sales: ([\d,.]+), /);
    check(
      Number(ordersLine?.[1]) === expectDay.length &&
        ordersLine?.[2] === sales(expectDay).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) &&
        inDay(prevStart, dayStart).length >= 1,
      "yesterday's orders and sales (refunded left out), against the day before",
      `${body.split('\n')[1]} (expected ${expectDay.length} orders, ${sales(expectDay).toFixed(2)})`
    );
    check(/- Needs action: 4 orders\. Oldest unshipped: #R\d+, placed 20 days ago\./.test(body), 'what needs action, oldest first', body.split('\n')[2]);
    check(/- Late: 2 paid orders not shipped after 24 hours\./.test(body), 'late orders (all of them, in the summary)', body.split('\n')[3]);
    check(/- Stock: 1 running low, 1 out of stock\./.test(body), 'stock');
    check(/- Agent: 3 decisions \(2 fulfill, 1 hold\)\. 1 of 2 rated right\./.test(body), "yesterday's decisions and how they were rated");
    check(/aren't rated yet: https:\/\/ops\.example\.test\/decisions\?show=unrated/.test(body) || /isn't rated yet/.test(body), 'a nudge to rate the rest');
    const summaryTg = tg.calls.find((c) => c.method === 'sendMessage' && /Daily summary for Report Shop/.test(c.params.text));
    check(summaryTg && summaryTg.params.chat_id === '4242' && !summaryTg.params.reply_markup, 'sent to Telegram too, without rating buttons');
    check((await sellerRow(seller)).sent_on === today, 'marked sent for today');
    await pool.query('UPDATE sellers SET summary_sent_on = NULL WHERE id = ?', [seller]);
    queued = await queueDueReports();
    check(queued.summaries === 0, "even if the mark is lost, the day's key stops a second one");
    await pool.query('UPDATE sellers SET summary_sent_on = ? WHERE id = ?', [today, seller]);
    res = await call('POST', '/api/settings/reports/summary', seller);
    check(res.status === 200 && res.json.results.every((r) => r.ok) && res.json.results.length === 2, '"Send one now" sends a preview', JSON.stringify(res.json?.results));

    console.log('\n3. Late-order alerts');
    await pool.query('UPDATE sellers SET summary_enabled = FALSE, late_alerts_enabled = TRUE, late_after_hours = 24 WHERE id = ?', [seller]);
    const other = await addSeller('Other Shop', { late_alerts_enabled: 1 });
    await order(other, now - 30 * HOUR, null, 'paid', '77.00');
    const tgBefore = tg.calls.length;
    queued = await queueDueReports();
    check(queued.late >= 1, 'queued');
    await allDone(seller);
    const lateTg = await until(() => tg.calls.slice(tgBefore).find((c) => c.method === 'sendMessage' && /Late orders/.test(c.params.text)));
    const lines = lateTg?.params.text.split('\n') || [];
    check(lines[0] === 'Late orders: 1 paid order not shipped after 24 hours', 'one alert for the newly late orders', lines[0]);
    check(lines.length === 3 && /^- #R\d+, placed 30 hours ago, 58\.00$/.test(lines[1]), 'names only the paid order past 24 hours in the last 14 days', lines[1]);
    const [[late]] = await pool.query('SELECT late_alerted_at FROM orders WHERE id = ?', [lateId]);
    check(Boolean(late?.late_alerted_at), 'the order is marked as alerted');
    check((await queueDueReports()).late === 0, 'and never named again');

    console.log('\n4. Rating from alerts');
    const [d] = await pool.query("INSERT INTO decisions (seller_id, order_number, reasoning, action_taken) VALUES (?, '#R9', 'HOLD - Payment still pending\n- wait', 'hold')", [seller]);
    const decisionId = d.insertId;
    const mailsBefore2 = smtp.messages.length;
    const tgBefore2 = tg.calls.length;
    await postDecision(seller, '*New order #R9*\nHOLD - Payment still pending\n- wait', { decisionId });
    const alertMail = await until(() => smtp.messages.slice(mailsBefore2).find((m) => /New order #R9/.test(mailSubject(m))));
    const links = [...(alertMail ? mailBody(alertMail) : '').matchAll(/(Yes|No): (https:\/\/ops\.example\.test\/rate\?t=([^&\s]+)&r=(up|down))/g)];
    check(links.length === 2 && links[0][4] === 'up' && links[1][4] === 'down', 'the email has Yes and No links to the rating page', links.map((l) => l[2]).join(' '));
    const alertTg = tg.calls.slice(tgBefore2).find((c) => c.method === 'sendMessage' && /New order #R9/.test(c.params.text));
    check(
      JSON.stringify(alertTg?.params.reply_markup?.inline_keyboard?.[0]?.map((b) => b.callback_data)) === JSON.stringify([`rate:${decisionId}:up`, `rate:${decisionId}:down`]),
      'the Telegram alert has Right call / Wrong call buttons'
    );

    const token = decodeURIComponent(links[0]?.[3] || '');
    res = await call('GET', `/api/rate/${encodeURIComponent(token)}`);
    check(
      res.status === 200 && res.json.decision.id === decisionId && res.json.decision.headline === 'HOLD - Payment still pending' && res.json.business_name === 'Report Shop' && !('reasoning' in res.json.decision),
      'the link opens that decision (its first line, not the full reasoning)',
      JSON.stringify(res.json)
    );
    const [[untouched]] = await pool.query('SELECT feedback FROM decisions WHERE id = ?', [decisionId]);
    check(untouched.feedback === null, 'opening the link saves nothing');
    res = await call('PUT', `/api/rate/${encodeURIComponent(token)}`, null, { feedback: 'down', note: 'Bank transfers show pending first' });
    let [[rated]] = await pool.query('SELECT feedback, feedback_note FROM decisions WHERE id = ?', [decisionId]);
    check(res.status === 200 && rated.feedback === 'down' && rated.feedback_note === 'Bank transfers show pending first', 'Save rates it, with the note');
    res = await call('PUT', `/api/rate/${encodeURIComponent(token)}`, null, { feedback: 'sideways' });
    check(res.status === 400, 'bad values refused');
    const [otherToken, signature] = [token.replace(/^\d+\./, `${decisionId + 1}.`), token];
    res = await call('GET', `/api/rate/${encodeURIComponent(otherToken)}`);
    check(res.status === 404 && signature !== otherToken, 'changing the decision in the link breaks it', String(res.status));
    res = await call('GET', `/api/rate/${encodeURIComponent(ratingToken(decisionId, seller, Date.now() - 31 * 86400 * 1000))}`);
    check(res.status === 410 && /expired/.test(res.json?.error), 'links expire after 30 days');
    const [skip] = await pool.query("INSERT INTO decisions (seller_id, reasoning, action_taken) VALUES (?, 'SKIPPED - limit', 'skipped')", [seller]);
    res = await call('GET', `/api/rate/${encodeURIComponent(ratingToken(skip.insertId, seller))}`);
    check(res.status === 404, 'a skipped run has nothing to rate');

    // Telegram: a tap from the seller's chat, then from a stranger's.
    await pool.query('UPDATE decisions SET feedback = NULL, feedback_note = NULL, feedback_at = NULL WHERE id = ?', [decisionId]);
    tg.queue.push({ update_id: 100, callback_query: { id: 'cb1', data: `rate:${decisionId}:up`, message: { message_id: 55, chat: { id: 4242 } } } });
    const answered = await until(() => tg.calls.find((c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === 'cb1'));
    [[rated]] = await pool.query('SELECT feedback FROM decisions WHERE id = ?', [decisionId]);
    check(rated.feedback === 'up' && answered?.params.text === 'Saved: right call', 'one tap on Right call rates it', answered?.params.text);
    const edited = tg.calls.find((c) => c.method === 'editMessageReplyMarkup' && c.params.message_id === 55);
    check(edited?.params.reply_markup.inline_keyboard[0][0].text === '✓ Right call', 'and the button shows it');
    tg.queue.push({ update_id: 101, callback_query: { id: 'cb2', data: `rate:${decisionId}:down`, message: { message_id: 56, chat: { id: 9999 } } } });
    const refused = await until(() => tg.calls.find((c) => c.method === 'answerCallbackQuery' && c.params.callback_query_id === 'cb2'));
    [[rated]] = await pool.query('SELECT feedback FROM decisions WHERE id = ?', [decisionId]);
    check(rated.feedback === 'up' && /can't rate/.test(refused?.params.text || ''), "another chat can't rate it");

    tg.queue.push({ update_id: 102, callback_query: { id: 'cb3', data: `rate:${decisionId}:down`, message: { message_id: 55, chat: { id: 4242 } } } });
    const prompt = await until(() => tg.calls.find((c) => c.method === 'sendMessage' && /What should it have done\?/.test(c.params.text)));
    check(prompt?.params.reply_markup?.force_reply === true && prompt.params.text.endsWith(`(decision #${decisionId})`), 'Wrong call asks for a note, as a reply');
    tg.queue.push({ update_id: 103, message: { message_id: 57, chat: { id: 9999 }, text: 'sneaky note', reply_to_message: { from: { is_bot: true }, text: prompt?.params.text } } });
    tg.queue.push({ update_id: 104, message: { message_id: 58, chat: { id: 4242 }, text: 'Ship bank transfers, they clear in a day', reply_to_message: { from: { is_bot: true }, text: prompt?.params.text } } });
    const thanks = await until(() => tg.calls.find((c) => c.method === 'sendMessage' && c.params.chat_id === 4242 && /Thanks, noted/.test(c.params.text)));
    [[rated]] = await pool.query('SELECT feedback, feedback_note FROM decisions WHERE id = ?', [decisionId]);
    check(Boolean(thanks) && rated.feedback === 'down' && rated.feedback_note === 'Ship bank transfers, they clear in a day', 'the reply becomes the note');
    const stranger = tg.calls.find((c) => c.method === 'sendMessage' && c.params.chat_id === 9999 && /can't add a note/.test(c.params.text));
    check(Boolean(stranger), "a reply from another chat doesn't");
  } finally {
    telegram.stopTelegramPolling();
    await queue.stopWorker(5000);
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM orders WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM inventory_items WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]); // their jobs go with them
    }
    console.log('\nRemoved the test sellers and their data.');
    await wait(400); // let the last getUpdates return
    server.close();
    smtp.server.close();
    tg.server.close();
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
