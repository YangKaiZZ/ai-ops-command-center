const crypto = require('crypto');
const { JWT_SECRET } = require('../config/secrets');

// Links in alerts (Slack buttons, email) that let the seller rate one agent
// decision without signing in. The link names the decision and the seller
// and is signed, so it can't be changed to rate anything else, and it
// expires. It opens a page with a Save button: opening the link alone never
// saves a rating, because mail scanners open links in emails by themselves.

const TTL_DAYS = 30;
// Its own key, derived from JWT_SECRET: a rating token is never a sign-in token.
const KEY = crypto.createHmac('sha256', JWT_SECRET).update('decision-rating-links').digest();

const sign = (payload) => crypto.createHmac('sha256', KEY).update(payload).digest('base64url');

// "<decision id>.<seller id>.<expires, epoch seconds>.<signature>"
function ratingToken(decisionId, sellerId, nowMs = Date.now()) {
  const payload = `${decisionId}.${sellerId}.${Math.floor(nowMs / 1000) + TTL_DAYS * 86400}`;
  return `${payload}.${sign(payload)}`;
}

// { decisionId, sellerId }, or { error: 'invalid' | 'expired' }.
function verifyRatingToken(token, nowMs = Date.now()) {
  const match = typeof token === 'string' && token.length <= 200 && token.match(/^(\d{1,12})\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return { error: 'invalid' };
  const [, decisionId, sellerId, expires, signature] = match;
  const expected = Buffer.from(sign(`${decisionId}.${sellerId}.${expires}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'invalid' };
  if (Number(expires) * 1000 < nowMs) return { error: 'expired' };
  return { decisionId: Number(decisionId), sellerId: Number(sellerId) };
}

function dashboardUrl() {
  return (process.env.DASHBOARD_URL || 'http://localhost:3005').replace(/\/+$/, '');
}

// The rating page for one decision, with "up" or "down" picked already.
function ratingUrl(decisionId, sellerId, feedback, nowMs = Date.now()) {
  return `${dashboardUrl()}/rate?t=${encodeURIComponent(ratingToken(decisionId, sellerId, nowMs))}&r=${feedback}`;
}

module.exports = { ratingToken, verifyRatingToken, ratingUrl, dashboardUrl, TTL_DAYS };
