const pool = require('../config/db');
const { keyedHash } = require('../config/secrets');

// How often something may happen per account or per IP address, counted in
// the database (rate_limit_events) so a restart doesn't reset the counts.
// Emails and addresses are stored only as keyed hashes. A request is checked
// before the work and recorded after it, so a blocked attempt doesn't
// lengthen its own wait.
const LIMITS = {
  // Failed sign-ins for one email, from anywhere: slows guessing one password.
  loginFailuresPerAccount: { bucket: 'login-fail:account', max: 10, windowSeconds: 15 * 60 },
  // Failed sign-ins from one address, for any email: slows trying many accounts.
  loginFailuresPerIp: { bucket: 'login-fail:ip', max: 30, windowSeconds: 15 * 60 },
  // New accounts from one address.
  signupsPerIp: { bucket: 'signup:ip', max: 10, windowSeconds: 60 * 60 },
  // Wrong invite codes from one address: slows guessing the sign-up code.
  inviteFailuresPerIp: { bucket: 'invite-fail:ip', max: 10, windowSeconds: 60 * 60 },
  // Reset emails per address (known or not): stops mail-bombing one inbox.
  resetRequestsPerAccount: { bucket: 'reset-request:account', max: 3, windowSeconds: 60 * 60 },
  // Reset emails asked for from one address, for any email.
  resetRequestsPerIp: { bucket: 'reset-request:ip', max: 10, windowSeconds: 60 * 60 },
  // Reset links that didn't work, from one address: slows guessing tokens.
  resetFailuresPerIp: { bucket: 'reset-fail:ip', max: 20, windowSeconds: 15 * 60 },
};

function subjectKey(limit, value) {
  return keyedHash(`${limit.bucket}:${String(value).trim().toLowerCase()}`);
}

// Requests from this machine (tests, local development, health checks) aren't
// limited by address; per-account limits still apply to them.
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Seconds until one more is allowed; 0 when it's allowed now.
async function secondsUntilAllowed(limit, value) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n, TIMESTAMPDIFF(SECOND, MIN(created_at), NOW()) AS oldest_age
     FROM rate_limit_events WHERE bucket = ? AND subject = ? AND created_at > NOW() - INTERVAL ? SECOND`,
    [limit.bucket, subjectKey(limit, value), limit.windowSeconds]
  );
  if (Number(row.n) < limit.max) return 0;
  return Math.max(1, limit.windowSeconds - Number(row.oldest_age));
}

async function record(limit, value) {
  await pool.query('INSERT INTO rate_limit_events (bucket, subject) VALUES (?, ?)', [limit.bucket, subjectKey(limit, value)]);
}

async function clear(limit, value) {
  await pool.query('DELETE FROM rate_limit_events WHERE bucket = ? AND subject = ?', [limit.bucket, subjectKey(limit, value)]);
}

// "about 12 minutes" for a wait in seconds.
function describeWait(seconds) {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? 'about a minute' : `about ${minutes} minutes`;
}

// A 429 with Retry-After, in the API's usual { error } shape.
function tooManyRequests(res, seconds, what) {
  res.set('Retry-After', String(seconds));
  return res.status(429).json({ error: `${what}. Try again in ${describeWait(seconds)}.`, retry_after: seconds });
}

module.exports = { LIMITS, subjectKey, isLoopback, secondsUntilAllowed, record, clear, describeWait, tooManyRequests };
