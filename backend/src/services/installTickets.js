const crypto = require('crypto');
const { JWT_SECRET } = require('../config/secrets');

// A seller who installs one of our apps from Shopify's install link lands on
// sign-up with a ticket: proof that Shopify sent them (the install request was
// signed by the app), so they don't need the invite code. The ticket names the
// store, and expires after a day.

const TTL_HOURS = 24;
// Its own key, derived from JWT_SECRET: not a sign-in token, not an alert link.
const KEY = crypto.createHmac('sha256', JWT_SECRET).update('install-tickets').digest();

const sign = (shop, expires) => crypto.createHmac('sha256', KEY).update(`${shop}.${expires}`).digest('base64url');

// "<expires, epoch seconds>.<signature>", for this store.
function installTicket(shop, nowMs = Date.now()) {
  const expires = Math.floor(nowMs / 1000) + TTL_HOURS * 3600;
  return `${expires}.${sign(shop, expires)}`;
}

// Whether the ticket was made for this store and hasn't expired.
function isValidInstallTicket(shop, ticket, nowMs = Date.now()) {
  const match = typeof shop === 'string' && typeof ticket === 'string' && ticket.match(/^(\d{1,12})\.([A-Za-z0-9_-]{43})$/);
  if (!match) return false;
  const [, expires, signature] = match;
  const expected = Buffer.from(sign(shop, expires));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) && Number(expires) * 1000 >= nowMs;
}

module.exports = { installTicket, isValidInstallTicket, TTL_HOURS };
