const crypto = require('crypto');

// A single shared sign-up code from SIGNUP_INVITE_CODE, so strangers can't
// create accounts (and connect stores that spend LLM credits) before you're
// ready. Not set: sign-up is open. Read on each call so a restart isn't the
// only way to notice a change in tests.
function requiredCode() {
  return (process.env.SIGNUP_INVITE_CODE || '').trim();
}

function isInviteRequired() {
  return requiredCode() !== '';
}

const digest = (value) => crypto.createHash('sha256').update(value).digest();

// Compares hashes in constant time, so the check doesn't leak how much of a guess was right.
function isValidInviteCode(given) {
  const expected = requiredCode();
  if (!expected) return true;
  return typeof given === 'string' && crypto.timingSafeEqual(digest(given.trim()), digest(expected));
}

module.exports = { isInviteRequired, isValidInviteCode };
