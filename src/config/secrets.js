const crypto = require('crypto');
require('dotenv').config({ quiet: true });

// Both secrets are required: with no fallback, a missing .env stops the
// server at startup instead of silently signing logins with a guessable key.
const PLACEHOLDERS = new Set(['change-this-to-something-random', 'dev-secret-change-this']);

function loadJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || PLACEHOLDERS.has(secret) || secret.length < 16) {
    throw new Error(
      'JWT_SECRET must be set in .env to a random value of at least 16 characters (32+ recommended). ' +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return secret;
}

// ENCRYPTION_KEY: 32 bytes, as base64 or hex. Encrypts Shopify access tokens
// and Slack webhook URLs at rest.
function loadEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY must be set in .env to 32 random bytes (base64 or hex). ' +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
    );
  }
  return key;
}

const JWT_SECRET = loadJwtSecret();
const ENCRYPTION_KEY = loadEncryptionKey();

// Stored as enc:v1:<iv>:<auth tag>:<ciphertext>, all base64. AES-256-GCM, so
// a tampered value fails to decrypt instead of decrypting to garbage.
const PREFIX = 'enc:v1:';

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((b) => b.toString('base64')).join(':');
}

// Values written before encryption existed are returned as-is;
// `npm run migrate` encrypts them.
function decryptSecret(stored) {
  if (stored == null || stored === '') return null;
  if (!isEncrypted(stored)) return stored;
  const [iv, tag, ciphertext] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { JWT_SECRET, encryptSecret, decryptSecret, isEncrypted };
