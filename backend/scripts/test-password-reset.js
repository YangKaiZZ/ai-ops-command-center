// End-to-end check of password reset, run in-process against a fake SMTP server
// (TRUST_PROXY=1 so checks can come from their own documentation-range IPs).
// The real database is used; test accounts and counters are removed.
//   1. asking for a link answers the same for known and unknown emails; only the known one gets mail
//   2. only the token's hash is stored
//   3. a reset changes the password, and signs out older sign-in tokens
//   4. a link works once, expires, and a newer link replaces an older one
//   5. a short password is refused without spending the link
//   6. limits: 3 emails per address per hour (known or not); bad links per IP
//   7. a reset lifts a sign-in lockout
//   8. without SMTP settings the request says so
//
// Usage:  npm run test:password-reset
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.TRUST_PROXY = '1';

const crypto = require('crypto');
const net = require('net');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  for (let t = 0; t < ms; t += 50) {
    const v = fn();
    if (v) return v;
    await wait(50);
  }
  return null;
}

// A fake SMTP server that keeps every message.
function startFakeSmtp() {
  const messages = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    let to = [];
    socket.write('220 fake-smtp ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ to, raw: data });
            data = '';
            socket.write('250 queued\r\n');
          } else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-fake-smtp\r\n250 8BITMIME\r\n');
        else if (cmd === 'HELO' || cmd === 'RSET' || cmd === 'NOOP') socket.write('250 ok\r\n');
        else if (cmd === 'MAIL') {
          to = [];
          socket.write('250 ok\r\n');
        } else if (cmd === 'RCPT') {
          to.push(line.match(/<([^>]+)>/)?.[1]);
          socket.write('250 ok\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.address().port })));
}

// The reset token in a mail, whether or not the mail was quoted-printable encoded.
function tokenIn(message) {
  const text = message.raw.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
  return text.match(/reset-password\?token=([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

async function main() {
  const smtp = await startFakeSmtp();
  Object.assign(process.env, { SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, EMAIL_FROM: 'AI Ops <alerts@example.test>' });

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const { LIMITS } = require('../src/services/rateLimit');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const run = crypto.randomBytes(3).toString('hex');
  const counters = []; // [limit, value] pairs, to remove their counters at the end
  const { subjectKey } = require('../src/services/rateLimit');
  const ip = () => {
    const address = `198.51.100.${crypto.randomInt(1, 255)}`;
    for (const limit of Object.values(LIMITS)) counters.push([limit, address]);
    return address;
  };
  const email = (name) => {
    const address = `pr-${run}-${name}@example.test`;
    for (const limit of Object.values(LIMITS)) counters.push([limit, address]);
    return address;
  };
  const post = async (route, body, from) => {
    const res = await fetch(`${base}/api/auth/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(from ? { 'X-Forwarded-For': from } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json().catch(() => ({})) };
  };
  const whoAmI = async (token) => (await fetch(`${base}/api/orders`, { headers: { Authorization: `Bearer ${token}` } })).status;
  const mailsTo = (address) => smtp.messages.filter((m) => m.to.includes(address));
  const password = `pw-${run}-original`;
  const newPassword = `pw-${run}-brand-new`;
  const sellerIds = [];

  const signUp = async (address) => {
    const res = await post('register', { business_name: 'Reset test', email: address, password }, ip());
    sellerIds.push(res.body.sellerId);
    return res.body.token;
  };

  try {
    console.log('\n1. Asking for a link');
    const owner = email('owner');
    const unknown = email('nobody');
    const oldToken = await signUp(owner);
    check((await whoAmI(oldToken)) === 200, 'the sign-in token works before the reset');

    const known = await post('forgot-password', { email: owner }, ip());
    const missing = await post('forgot-password', { email: unknown }, ip());
    check(known.status === 202 && missing.status === 202, 'known and unknown emails both get 202', `${known.status}, ${missing.status}`);
    check(JSON.stringify(known.body) === JSON.stringify(missing.body), 'with the same message');
    const mail = await until(() => mailsTo(owner)[0]);
    check(Boolean(mail), 'the account\'s owner gets an email');
    await wait(300);
    check(mailsTo(unknown).length === 0, 'the unknown address gets nothing');
    const token = mail && tokenIn(mail);
    check(Boolean(token) && token.length >= 40, 'the email has a reset link with a token');
    check((await post('forgot-password', { email: 'not-an-email' }, ip())).status === 400, 'a malformed email is refused');

    console.log('\n2. Only a hash is stored');
    const [rows] = await pool.query('SELECT token_hash FROM password_resets WHERE seller_id = ?', [sellerIds[0]]);
    check(rows.length === 1 && rows[0].token_hash !== token && /^[0-9a-f]{64}$/.test(rows[0].token_hash), 'the table holds a SHA-256 hash, not the token');

    console.log('\n3. Resetting');
    check((await post('reset-password', { token, password: 'short' }, ip())).status === 400, 'a too-short password is refused');
    const [[stillOpen]] = await pool.query('SELECT used_at FROM password_resets WHERE seller_id = ?', [sellerIds[0]]);
    check(stillOpen.used_at === null, 'and the link is not spent by it');
    await wait(1100); // sign-in tokens are dated to the second
    const reset = await post('reset-password', { token, password: newPassword }, ip());
    check(reset.status === 200, 'the link and a good password change it', reset.body.error || '');
    check((await post('login', { email: owner, password }, ip())).status === 401, 'the old password no longer works');
    const login = await post('login', { email: owner, password: newPassword }, ip());
    check(login.status === 200 && Boolean(login.body.token), 'the new password signs in');
    check((await whoAmI(oldToken)) === 401, 'the old sign-in token is signed out');
    check((await whoAmI(login.body.token)) === 200, 'a token from the new sign-in works');

    console.log('\n4. One use, expiry, newer links');
    const again = await post('reset-password', { token, password: `${newPassword}-2` }, ip());
    check(again.status === 400 && /invalid or has expired/.test(again.body.error), 'the same link a second time is refused');

    const expiring = email('expiring');
    await signUp(expiring);
    await post('forgot-password', { email: expiring }, ip());
    const expiringMail = await until(() => mailsTo(expiring)[0]);
    await pool.query('UPDATE password_resets SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE seller_id = ?', [sellerIds[1]]);
    check((await post('reset-password', { token: tokenIn(expiringMail), password: newPassword }, ip())).status === 400, 'an expired link is refused');

    const replaced = email('replaced');
    await signUp(replaced);
    await post('forgot-password', { email: replaced }, ip());
    const older = await until(() => mailsTo(replaced)[0]);
    await post('forgot-password', { email: replaced }, ip());
    const newer = await until(() => mailsTo(replaced)[1]);
    check((await post('reset-password', { token: tokenIn(older), password: newPassword }, ip())).status === 400, 'a link is replaced when a newer one is requested');
    check((await post('reset-password', { token: tokenIn(newer), password: newPassword }, ip())).status === 200, 'the newest one works');

    console.log('\n5. Limits');
    const limited = email('limited');
    await signUp(limited);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post('forgot-password', { email: limited }, ip())).status);
    check(statuses.every((s) => s === 202), '3 requests for one email (from different addresses) are answered');
    const fourthRequest = await post('forgot-password', { email: limited }, ip());
    check(fourthRequest.status === 429 && Number(fourthRequest.retryAfter) > 3000, 'the 4th gets 429 with Retry-After', `${fourthRequest.status}, ${fourthRequest.retryAfter}`);
    const nobody = email('nobody-limited');
    for (let i = 0; i < 3; i++) await post('forgot-password', { email: nobody }, ip());
    check((await post('forgot-password', { email: nobody }, ip())).status === 429, 'an email with no account is limited the same way');
    await wait(300);
    check(mailsTo(limited).length === 3, 'so the limited email got 3 messages, not 4', String(mailsTo(limited).length));

    const guesser = ip();
    const results = [];
    for (let i = 0; i < 20; i++) results.push((await post('reset-password', { token: crypto.randomBytes(32).toString('base64url'), password: newPassword }, guesser)).status);
    check(results.every((s) => s === 400), '20 wrong links from one address get 400');
    check((await post('reset-password', { token: crypto.randomBytes(32).toString('base64url'), password: newPassword }, guesser)).status === 429, 'the 21st gets 429');
    const [[stillGood]] = await pool.query('SELECT COUNT(*) AS n FROM password_resets WHERE seller_id = ? AND used_at IS NULL', [sellerIds[3]]);
    const goodToken = tokenIn(mailsTo(limited)[2]);
    check((await post('reset-password', { token: goodToken, password: newPassword }, guesser)).status === 429, 'even a good link waits, from that address');
    check((await post('reset-password', { token: goodToken, password: newPassword }, ip())).status === 200, 'but works from another', `${stillGood.n} open link(s)`);

    console.log('\n6. A reset lifts a lockout');
    const locked = email('locked');
    await signUp(locked);
    for (let i = 0; i < 10; i++) await post('login', { email: locked, password: 'wrong-password' }, ip());
    check((await post('login', { email: locked, password }, ip())).status === 429, 'ten failures lock the account');
    await post('forgot-password', { email: locked }, ip());
    const lockMail = await until(() => mailsTo(locked)[0]);
    check((await post('reset-password', { token: tokenIn(lockMail), password: newPassword }, ip())).status === 200, 'the emailed link still works');
    check((await post('login', { email: locked, password: newPassword }, ip())).status === 200, 'and the new password signs in at once');

    console.log('\n7. Without SMTP settings');
    const saved = process.env.SMTP_URL;
    delete process.env.SMTP_URL;
    const off = await post('forgot-password', { email: owner }, ip());
    check(off.status === 503 && /isn't set up/.test(off.body.error), 'it says so (503)', off.body.error);
    process.env.SMTP_URL = saved;
  } finally {
    for (const [limit, value] of counters) {
      await pool.query('DELETE FROM rate_limit_events WHERE bucket = ? AND subject = ?', [limit.bucket, subjectKey(limit, value)]);
    }
    for (const id of sellerIds.filter(Boolean)) await pool.query('DELETE FROM sellers WHERE id = ?', [id]);
    console.log('\nRemoved the test accounts and counters.');
    server.close();
    smtp.server.close();
    await pool.end();
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
