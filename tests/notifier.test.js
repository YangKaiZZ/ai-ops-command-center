const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const { isSlackWebhookUrl } = require('../src/services/notifier');

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
