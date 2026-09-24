const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { isSlackWebhookUrl, plainText, subjectLine } = require('../src/services/notifier');

test('email subjects name the event and the verdict', () => {
  assert.equal(subjectLine('*New order #1001*\nHOLD - 2 short\n- Snowboard'), 'New order #1001: HOLD');
  assert.equal(subjectLine('*Low stock: Mug, Tote*\nRESTOCK - both low'), 'Low stock: Mug, Tote: RESTOCK');
  assert.equal(subjectLine('*Test alert*\nThis is how alerts look.'), 'Test alert');
  assert.equal(subjectLine(''), 'AI Ops alert');
});

test('email and Telegram get the text without Slack bold markers', () => {
  assert.equal(plainText('*New order #1001*\nHOLD'), 'New order #1001\nHOLD');
});

test('accepts Slack incoming-webhook URLs', () => {
  assert.ok(isSlackWebhookUrl('https://hooks.slack.com/services/T000/B000/XXXX'));
  assert.ok(isSlackWebhookUrl('https://hooks.slack.com/triggers/T000/123/abc'));
});

test('rejects anything the server should not POST to', () => {
  for (const url of [
    '',
    'not a url',
    'http://hooks.slack.com/services/T000/B000/XXXX', // not https
    'https://hooks.slack.com/', // no webhook path
    'https://hooks.slack.com.evil.example/services/x',
    'https://evil.example/?https://hooks.slack.com/services/x',
    'https://localhost:3000/api/orders',
    'https://169.254.169.254/latest/meta-data',
  ]) {
    assert.equal(isSlackWebhookUrl(url), false, url);
  }
});
