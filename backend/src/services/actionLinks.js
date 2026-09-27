const crypto = require('crypto');
const { JWT_SECRET } = require('../config/secrets');
const { dashboardUrl } = require('./ratingLinks');

// Links in alerts (Slack buttons, email) that open a page to put one order on
// hold in Shopify, or mark it fulfilled, without signing in. The link names
// the order, the seller and the action, and is signed, so it can't be changed
// to act on anything else; it expires after a week. Opening it never acts:
// the page shows the order as Shopify has it now and waits for a confirm
// click, because mail scanners open links in emails by themselves.

const TTL_DAYS = 7;
const ACTIONS = ['hold', 'fulfill'];
// Its own key, derived from JWT_SECRET: not a sign-in token, not a rating token.
const KEY = crypto.createHmac('sha256', JWT_SECRET).update('order-action-links').digest();

const sign = (payload) => crypto.createHmac('sha256', KEY).update(payload).digest('base64url');

// "<order id>.<seller id>.<hold|fulfill>.<expires, epoch seconds>.<signature>"
function orderActionToken(orderId, sellerId, action, nowMs = Date.now()) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action ${action}`);
  const payload = `${orderId}.${sellerId}.${action}.${Math.floor(nowMs / 1000) + TTL_DAYS * 86400}`;
  return `${payload}.${sign(payload)}`;
}

// { orderId, sellerId, action, expiresAt }, or { error: 'invalid' | 'expired' }.
function verifyOrderActionToken(token, nowMs = Date.now()) {
  const match =
    typeof token === 'string' && token.length <= 200 && token.match(/^(\d{1,12})\.(\d{1,12})\.(hold|fulfill)\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return { error: 'invalid' };
  const [, orderId, sellerId, action, expires, signature] = match;
  const expected = Buffer.from(sign(`${orderId}.${sellerId}.${action}.${expires}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { error: 'invalid' };
  if (Number(expires) * 1000 < nowMs) return { error: 'expired' };
  return { orderId: Number(orderId), sellerId: Number(sellerId), action, expiresAt: new Date(Number(expires) * 1000) };
}

// The confirm page for one action on one order.
function orderActionUrl(orderId, sellerId, action, nowMs = Date.now()) {
  return `${dashboardUrl()}/act?t=${encodeURIComponent(orderActionToken(orderId, sellerId, action, nowMs))}`;
}

module.exports = { orderActionToken, verifyOrderActionToken, orderActionUrl, TTL_DAYS };
