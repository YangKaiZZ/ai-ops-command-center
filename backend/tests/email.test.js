const { test } = require('node:test');
const assert = require('node:assert/strict');
const { emailSettingsProblem } = require('../src/services/email');

const GOOD_URL = 'smtps://resend:re_secretKey123@smtp.resend.com:465';

test('right settings have no problem', () => {
  assert.equal(emailSettingsProblem(GOOD_URL, 'Arbiter Ops <alerts@example.com>'), null);
  assert.equal(emailSettingsProblem('smtp://127.0.0.1:2525', 'alerts@example.com'), null);
  assert.equal(emailSettingsProblem(GOOD_URL, '"Arbiter Ops" <alerts@mail.example.co.uk>'), null);
});

test('email left off is not a problem', () => {
  assert.equal(emailSettingsProblem(undefined, undefined), null);
  assert.equal(emailSettingsProblem('', 'Arbiter Ops <alerts@example.com>'), null);
});

test('an SMTP_URL that is only the key is caught, without repeating the key', () => {
  const problem = emailSettingsProblem('re_secretKey123', 'Arbiter Ops <alerts@example.com>');
  assert.match(problem, /SMTP_URL must be a whole address/);
  assert.doesNotMatch(problem, /secretKey/);
  assert.match(emailSettingsProblem('https://smtp.resend.com', 'alerts@example.com'), /SMTP_URL/); // wrong scheme
});

test('an EMAIL_FROM without a full address is caught', () => {
  assert.match(emailSettingsProblem(GOOD_URL, 'Arbiter Ops <example.com>'), /EMAIL_FROM needs a full address/);
  assert.match(emailSettingsProblem(GOOD_URL, 'Arbiter Ops'), /EMAIL_FROM/);
  assert.match(emailSettingsProblem(GOOD_URL, 'Arbiter Ops <alerts@example>'), /EMAIL_FROM/);
});
