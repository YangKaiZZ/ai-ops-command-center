const test = require('node:test');
const assert = require('node:assert/strict');
const { isInviteRequired, isValidInviteCode } = require('../src/services/inviteCode');

function withCode(value, fn) {
  const saved = process.env.SIGNUP_INVITE_CODE;
  if (value === undefined) delete process.env.SIGNUP_INVITE_CODE;
  else process.env.SIGNUP_INVITE_CODE = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.SIGNUP_INVITE_CODE;
    else process.env.SIGNUP_INVITE_CODE = saved;
  }
}

test('with no code set, sign-up is open', () => {
  for (const unset of [undefined, '', '   ']) {
    withCode(unset, () => {
      assert.equal(isInviteRequired(), false);
      assert.equal(isValidInviteCode(undefined), true);
    });
  }
});

test('with a code set, only that code is accepted', () => {
  withCode('let-me-in-2026', () => {
    assert.equal(isInviteRequired(), true);
    assert.equal(isValidInviteCode('let-me-in-2026'), true);
    assert.equal(isValidInviteCode('  let-me-in-2026 '), true, 'spaces around it are ignored');
    for (const wrong of ['', 'let-me-in-2027', 'LET-ME-IN-2026', 'let-me-in', undefined, null, 42, ['let-me-in-2026']]) {
      assert.equal(isValidInviteCode(wrong), false, String(wrong));
    }
  });
});
