const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DASHBOARD_URL = 'https://ops.example.test/';
const { isTimeZone, localDate, localParts, addDays, startOfDay } = require('../src/utils/timeZone');
const { summaryDue, formatSummary, formatLateOrders } = require('../src/services/reports');
const { parseReportSettings } = require('../src/controllers/reportsController');
const { ratingToken, verifyRatingToken, ratingUrl } = require('../src/services/ratingLinks');
const { slackPayload, emailBody, telegramButtons } = require('../src/services/notifier');

const NOW = new Date('2026-09-26T01:30:00Z'); // 09:30 in Manila, 21:30 the day before in New York

test('local dates and hours in a time zone', () => {
  assert.equal(localDate(NOW, 'Asia/Manila'), '2026-09-26');
  assert.equal(localDate(NOW, 'America/New_York'), '2026-09-25');
  assert.equal(localParts(NOW, 'Asia/Manila').hour, 9);
  assert.equal(localParts(new Date('2026-09-25T16:00:00Z'), 'Asia/Manila').hour, 0); // midnight is 0, not 24
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.ok(isTimeZone('Asia/Manila') && isTimeZone('UTC'));
  for (const bad of ['Mars/Olympus', '', null, 42, 'x'.repeat(65)]) assert.equal(isTimeZone(bad), false, String(bad));
});

test('a local day starts at local midnight, on the days the clocks change too', () => {
  assert.equal(startOfDay('2026-09-26', 'Asia/Manila').toISOString(), '2026-09-25T16:00:00.000Z');
  assert.equal(startOfDay('2026-09-26', 'UTC').toISOString(), '2026-09-26T00:00:00.000Z');
  // New York: clocks go forward on 8 March 2026 and back on 1 November 2026.
  assert.equal(startOfDay('2026-03-08', 'America/New_York').toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(startOfDay('2026-03-09', 'America/New_York').toISOString(), '2026-03-09T04:00:00.000Z');
  assert.equal(startOfDay('2026-11-01', 'America/New_York').toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(startOfDay('2026-11-02', 'America/New_York').toISOString(), '2026-11-02T05:00:00.000Z');
});

test('the summary is due once the hour has come, once a day', () => {
  const seller = { timezone: 'Asia/Manila', summary_hour: 8, summary_sent_on: null };
  assert.equal(summaryDue(seller, NOW), '2026-09-26'); // 09:30 local
  assert.equal(summaryDue({ ...seller, summary_hour: 10 }, NOW), null); // not yet
  assert.equal(summaryDue({ ...seller, summary_sent_on: '2026-09-26' }, NOW), null); // sent today
  assert.equal(summaryDue({ ...seller, summary_sent_on: '2026-09-25' }, NOW), '2026-09-26');
  assert.equal(summaryDue({ ...seller, timezone: 'America/New_York', summary_hour: 21 }, NOW), '2026-09-25'); // still the 25th there
  assert.equal(summaryDue({ ...seller, timezone: 'Nowhere/Land', summary_hour: 1 }, NOW), '2026-09-26'); // unknown zone: UTC
});

const numbers = {
  day: startOfDay('2026-09-25', 'Asia/Manila'),
  zone: 'Asia/Manila',
  orders: { count: 12, sales: 1548.85, previous_count: 9, previous_sales: 1338.85 },
  needs_action: 4,
  oldest_unshipped: { order_number: '#1041', order_placed_at: '2026-09-23T23:00:00Z' },
  late: 2,
  late_after_hours: 24,
  stock: { tracked: 30, low: 3, out_of_stock: 1 },
  running_out: [
    { item_name: 'Linen Scarf', days_left: 1.6, reorder_quantity: 40 },
    { item_name: 'Ceramic Mug', days_left: 5.2, reorder_quantity: 12 },
  ],
  decisions: { fulfill: 3, hold: 1, low_stock_alert: 1, unknown: 0, skipped: 0, total: 5 },
  ratings: { up: 4, down: 1, unrated: 0 },
  unrated_this_week: 3,
};

test('the summary says what happened yesterday and what needs doing', () => {
  const text = formatSummary(numbers, { businessName: 'Gloria Flowers', link: 'https://ops.example.test', now: NOW });
  assert.deepEqual(text.split('\n'), [
    '*Daily summary for Gloria Flowers: Fri, Sep 25*',
    '- Orders: 12, up 3 on the day before. Sales: 1,548.85, up 210.00 on the day before.',
    '- Needs action: 4 orders. Oldest unshipped: #1041, placed 2 days ago.', // 50 hours: said in days from 48
    '- Late: 2 paid orders not shipped after 24 hours.',
    '- Stock: 3 running low, 1 out of stock.',
    '- Runs out this week: Linen Scarf in about 2 days (reorder 40); Ceramic Mug in about 5 days (reorder 12).',
    '- Agent: 5 decisions (3 fulfill, 1 hold, 1 restock). 4 of 5 rated right.',
    "- 3 decisions from the last 7 days aren't rated yet: https://ops.example.test/decisions?show=unrated",
    'Dashboard: https://ops.example.test/overview',
  ]);
});

test('a quiet day is said plainly', () => {
  const quiet = {
    ...numbers,
    orders: { count: 0, sales: 0, previous_count: 0, previous_sales: 0 },
    needs_action: 0,
    oldest_unshipped: null,
    late: 0,
    stock: { tracked: 0, low: 0, out_of_stock: 0 },
    running_out: [],
    decisions: { fulfill: 0, hold: 0, low_stock_alert: 0, unknown: 0, skipped: 0, total: 0 },
    ratings: { up: 0, down: 0, unrated: 0 },
    unrated_this_week: 1,
  };
  const lines = formatSummary(quiet, { businessName: 'Shop', link: 'https://x.test', now: NOW }).split('\n');
  assert.deepEqual(lines.slice(1, 4), ['- Orders: none, and none the day before.', '- Needs action: nothing.', '- Agent: no decisions.']);
  assert.match(lines[4], /^- 1 decision from the last 7 days isn't rated yet/);
  const fewer = formatSummary({ ...quiet, orders: { count: 2, sales: 50, previous_count: 5, previous_sales: 50 } }, { businessName: 'Shop', link: 'https://x.test', now: NOW });
  assert.match(fewer, /Orders: 2, down 3 on the day before\. Sales: 50\.00, the same as the day before\./);
});

test('a late-order alert names each order, the first 10', () => {
  const order = (i) => ({ id: i, order_number: `#${1000 + i}`, total_amount: '58.00', order_placed_at: new Date(NOW - (30 + i) * 3600 * 1000) });
  const text = formatLateOrders([order(1), { ...order(2), order_number: null }], { afterHours: 24, link: 'https://x.test', now: NOW });
  assert.deepEqual(text.split('\n'), [
    '*Late orders: 2 paid orders not shipped after 24 hours*',
    '- #1001, placed 31 hours ago, 58.00',
    '- Order 2, placed 32 hours ago, 58.00',
    'Orders that need action: https://x.test/orders?needs_action=1',
  ]);
  const many = formatLateOrders(Array.from({ length: 13 }, (_, i) => order(i + 1)), { afterHours: 48, link: 'https://x.test', now: NOW }).split('\n');
  assert.equal(many.length, 1 + 10 + 1 + 1);
  assert.equal(many[11], '- and 3 more');
});

test('report settings: a real time zone, an hour, and 12, 24, 48 or 72 hours', () => {
  const good = { timezone: 'Asia/Manila', summary: { enabled: true, hour: 8 }, late_orders: { enabled: false, after_hours: 48 } };
  assert.deepEqual(parseReportSettings(good), {
    timezone: 'Asia/Manila',
    summary: { enabled: true, hour: 8 },
    lateOrders: { enabled: false, afterHours: 48 },
  });
  assert.match(parseReportSettings({ ...good, timezone: 'Mars/Olympus' }).error, /time zone/);
  for (const summary of [{ enabled: 'yes', hour: 8 }, { enabled: true, hour: 24 }, { enabled: true, hour: 7.5 }, undefined]) {
    assert.match(parseReportSettings({ ...good, summary }).error, /hour from 0 to 23/, JSON.stringify(summary));
  }
  for (const late of [{ enabled: true, after_hours: 36 }, { enabled: 1, after_hours: 24 }, null]) {
    assert.match(parseReportSettings({ ...good, late_orders: late }).error, /12, 24, 48, 72/, JSON.stringify(late));
  }
  assert.match(parseReportSettings(undefined).error, /time zone/);
});

test('rating links are signed, for one decision, and expire', () => {
  const token = ratingToken(42, 7, NOW.getTime());
  assert.deepEqual(verifyRatingToken(token, NOW.getTime()), { decisionId: 42, sellerId: 7 });
  assert.deepEqual(verifyRatingToken(token.replace(/^42\./, '43.'), NOW.getTime()), { error: 'invalid' }); // another decision
  assert.deepEqual(verifyRatingToken(token.replace(/\.7\./, '.8.'), NOW.getTime()), { error: 'invalid' }); // another seller
  assert.deepEqual(verifyRatingToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, NOW.getTime()), { error: 'invalid' });
  assert.deepEqual(verifyRatingToken(token, NOW.getTime() + 31 * 86400 * 1000), { error: 'expired' });
  for (const bad of ['', 'abc', null, '1.2.3', `${token}x`]) assert.deepEqual(verifyRatingToken(bad), { error: 'invalid' });
  const url = new URL(ratingUrl(42, 7, 'down', NOW.getTime()));
  assert.equal(url.origin + url.pathname, 'https://ops.example.test/rate');
  assert.equal(url.searchParams.get('r'), 'down');
  assert.deepEqual(verifyRatingToken(url.searchParams.get('t'), NOW.getTime()), { decisionId: 42, sellerId: 7 });
});

test('each channel gets its own way to rate a decision', () => {
  const rating = { decisionId: 42, up: 'https://x.test/rate?t=a&r=up', down: 'https://x.test/rate?t=a&r=down' };
  assert.deepEqual(slackPayload('*New order #1*\nHOLD - x', null), { text: '*New order #1*\nHOLD - x' });
  const slack = slackPayload('*New order #1*\nHOLD - x', rating);
  assert.equal(slack.text, '*New order #1*\nHOLD - x');
  assert.equal(slack.blocks[0].text.text, '*New order #1*\nHOLD - x');
  assert.deepEqual(
    slack.blocks[1].elements.map((b) => [b.text.text, b.url]),
    [
      ['Right call', rating.up],
      ['Wrong call', rating.down],
    ]
  );
  const mail = emailBody('*New order #1*\nHOLD - x', rating, 'Shop');
  assert.match(mail, /^New order #1\nHOLD - x\n\nWas this the right call\?\nYes: https:\/\/x\.test\/rate\?t=a&r=up\nNo: https:\/\/x\.test\/rate\?t=a&r=down\n\n--\nSent by AI Ops for Shop/);
  assert.doesNotMatch(emailBody('*Daily summary*', null, 'Shop'), /right call/);
  assert.deepEqual(telegramButtons(rating).inline_keyboard[0].map((b) => b.callback_data), ['rate:42:up', 'rate:42:down']);
  assert.equal(telegramButtons(null), undefined);
});
