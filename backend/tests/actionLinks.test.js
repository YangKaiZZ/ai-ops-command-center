const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.DASHBOARD_URL = 'https://ops.example.test/';
const { orderActionToken, verifyOrderActionToken, orderActionUrl, TTL_DAYS } = require('../src/services/actionLinks');
const { ratingToken, verifyRatingToken } = require('../src/services/ratingLinks');
const { slackPayload, emailBody, telegramButtons } = require('../src/services/notifier');

const NOW = new Date('2026-09-27T01:30:00Z').getTime();
const DAY = 86400 * 1000;

test('an action link names one order, one seller and one action, signed', () => {
  const token = orderActionToken(15, 7, 'hold', NOW);
  const verified = verifyOrderActionToken(token, NOW);
  assert.deepEqual({ ...verified, expiresAt: verified.expiresAt.toISOString() }, {
    orderId: 15,
    sellerId: 7,
    action: 'hold',
    expiresAt: new Date(NOW + TTL_DAYS * DAY).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  });
  assert.deepEqual(verifyOrderActionToken(token.replace(/^15\./, '16.'), NOW), { error: 'invalid' }); // another order
  assert.deepEqual(verifyOrderActionToken(token.replace(/\.7\./, '.8.'), NOW), { error: 'invalid' }); // another seller
  assert.deepEqual(verifyOrderActionToken(token.replace('.hold.', '.fulfill.'), NOW), { error: 'invalid' }); // another action
  assert.deepEqual(verifyOrderActionToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, NOW), { error: 'invalid' });
  assert.deepEqual(verifyOrderActionToken('garbage', NOW), { error: 'invalid' });
  assert.deepEqual(verifyOrderActionToken(undefined, NOW), { error: 'invalid' });
  assert.throws(() => orderActionToken(15, 7, 'release', NOW)); // only hold and fulfill are offered from alerts
});

test('an action link expires after a week', () => {
  const token = orderActionToken(15, 7, 'fulfill', NOW);
  assert.equal(TTL_DAYS, 7);
  assert.equal(verifyOrderActionToken(token, NOW + 6 * DAY).action, 'fulfill');
  assert.deepEqual(verifyOrderActionToken(token, NOW + 8 * DAY), { error: 'expired' });
});

test("action links and rating links can't stand in for each other", () => {
  const rating = ratingToken(15, 7, NOW);
  assert.deepEqual(verifyOrderActionToken(rating, NOW), { error: 'invalid' });
  const action = orderActionToken(15, 7, 'hold', NOW);
  assert.deepEqual(verifyRatingToken(action, NOW), { error: 'invalid' });
});

test('the link opens the confirm page on the dashboard', () => {
  const url = orderActionUrl(15, 7, 'hold', NOW);
  assert.match(url, /^https:\/\/ops\.example\.test\/act\?t=15\.7\.hold\.\d+\.[A-Za-z0-9_-]{43}$/);
});

const rating = { decisionId: 42, up: 'https://x.test/rate?t=a&r=up', down: 'https://x.test/rate?t=a&r=down' };
const actions = { orderId: 15, hold: 'https://x.test/act?t=h', fulfill: 'https://x.test/act?t=f' };

test('alerts about an order offer to hold or fulfill it', () => {
  const slack = slackPayload('*New order #1*\nHOLD - x', rating, actions);
  assert.equal(slack.blocks.length, 3);
  assert.deepEqual(
    slack.blocks[2].elements.map((b) => [b.text.text, b.url]),
    [
      ['Hold in Shopify', 'https://x.test/act?t=h'],
      ['Mark fulfilled', 'https://x.test/act?t=f'],
    ]
  );
  const riskAlert = slackPayload('*Fraud risk: order #1*', null, actions); // no decision to rate
  assert.deepEqual(riskAlert.blocks.map((b) => b.type), ['section', 'actions']);
  assert.equal(riskAlert.blocks[1].elements[0].action_id, 'shopify_hold');

  const mail = emailBody('*New order #1*\nHOLD - x', rating, 'Shop', actions);
  assert.match(
    mail,
    /No: https:\/\/x\.test\/rate\?t=a&r=down\n\nIn Shopify \(each link opens a page to confirm, and works for 7 days\):\nPut on hold: https:\/\/x\.test\/act\?t=h\nMark fulfilled: https:\/\/x\.test\/act\?t=f\n\n--\n/
  );
  assert.doesNotMatch(emailBody('*New order #1*', rating, 'Shop'), /In Shopify/);

  const keyboard = telegramButtons(rating, actions).inline_keyboard;
  assert.deepEqual(keyboard.map((row) => row.map((b) => b.callback_data)), [
    ['rate:42:up', 'rate:42:down'],
    ['act:15:hold', 'act:15:fulfill'],
  ]);
  assert.deepEqual(telegramButtons(null, actions).inline_keyboard.length, 1);
  assert.equal(telegramButtons(null, null), undefined);
});
