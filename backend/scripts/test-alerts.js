// End-to-end check of email and Telegram alerts, run in-process against a
// fake SMTP server and a fake Telegram API on localhost (nothing is really
// sent; the real database is used with a throwaway seller):
//   1. email: code sent, wrong code, right code, per-hour limit, too many tries
//   2. Telegram: link, /start via the real polling loop, reused link, /stop
//   3. alerts fan out to every channel; one failing channel doesn't stop the others
//
// Usage:  npm run test:alerts
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.SIGNUP_INVITE_CODE = ''; // these tests sign up without one

const net = require('net');
const http = require('http');
const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(50);
  }
  return null;
}

// --- a fake SMTP server: accepts every message and keeps it ---
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
        } else if (cmd === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.address().port })));
}

// --- a fake Telegram Bot API: getMe, getUpdates (from a queue), sendMessage ---
function startFakeTelegram() {
  const queue = [];
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      const params = body ? JSON.parse(body) : {};
      let result;
      if (method === 'getMe') result = { id: 1, is_bot: true, username: 'aiops_test_bot' };
      else if (method === 'sendMessage') {
        sent.push(params);
        result = { message_id: sent.length };
      } else if (method === 'getUpdates') {
        for (let i = 0; i < 6 && !queue.length; i++) await wait(50); // a short "long poll"
        result = queue.splice(0).filter((u) => u.update_id >= (params.offset || 0));
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result === undefined ? { ok: false, description: 'unknown method' } : { ok: true, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, queue, sent, port: server.address().port })));
}

async function main() {
  const smtp = await startFakeSmtp();
  const tg = await startFakeTelegram();
  Object.assign(process.env, {
    SMTP_URL: `smtp://127.0.0.1:${smtp.port}`,
    EMAIL_FROM: 'AI Ops <alerts@example.test>',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_API_BASE: `http://127.0.0.1:${tg.port}`,
  });

  const app = require('../src/app');
  const pool = require('../src/config/db');
  const telegram = require('../src/services/telegram');
  const { postDecision } = require('../src/services/notifier');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, url, token, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const run = crypto.randomBytes(3).toString('hex');
  const reg = await call('POST', '/api/auth/register', null, {
    business_name: 'Alerts Test',
    email: `alerts-${run}@example.test`,
    password: 'test-password-1',
  });
  const { sellerId, token } = reg.json;
  try {
    console.log(`Seller #${sellerId}`);
    const s0 = (await call('GET', '/api/settings', token)).json;
    check(s0.email_alerts.available && s0.telegram.available && s0.email_alerts.address === null && !s0.telegram.connected, 'both channels offered, none on');
    check(s0.email === `alerts-${run}@example.test`, 'the account email is still there');
    check((await call('POST', '/api/settings/test-alert', token)).status === 400, 'test alert with no channels -> asks to turn one on');

    console.log('\n1. Email');
    check((await call('PUT', '/api/settings/email', token, { email: 'not an email' })).status === 400, 'invalid address rejected');
    const address = `owner-${run}@example.test`;
    const start = await call('PUT', '/api/settings/email', token, { email: address.toUpperCase() });
    const codeMail = await until(() => smtp.messages.find((m) => m.to.includes(address)));
    const code = codeMail?.raw.match(/Enter (\d{6}) in AI Ops/)?.[1];
    check(start.status === 200 && start.json.pending === address && code, 'code emailed to the (lower-cased) address', code ? 'code received' : 'no code');
    check(/Subject: Your AI Ops code: \d{6}/.test(codeMail?.raw || ''), 'code in the subject too');
    const pending = (await call('GET', '/api/settings', token)).json.email_alerts;
    check(pending.pending === address && pending.address === null, 'settings: waiting for the code, not on yet');

    const wrongCode = code === '000000' ? '111111' : '000000';
    const wrong = await call('POST', '/api/settings/email/verify', token, { code: wrongCode });
    check(wrong.status === 400 && /isn't right/.test(wrong.json.error), 'wrong code refused');
    const right = await call('POST', '/api/settings/email/verify', token, { code: ` ${code} ` });
    check(right.status === 200 && right.json.email_alerts.address === address, 'right code turns email alerts on');
    const again = await call('POST', '/api/settings/email/verify', token, { code });
    check(again.status === 400, 'a used code does not work twice', again.json.error);

    for (let i = 0; i < 3; i++) await call('PUT', '/api/settings/email', token, { email: `other-${i}-${run}@example.test` });
    await call('DELETE', '/api/settings/email', token); // cancelling must not reset the limit
    const fifth = await call('PUT', '/api/settings/email', token, { email: `other-4-${run}@example.test` });
    const sixth = await call('PUT', '/api/settings/email', token, { email: `other-5-${run}@example.test` });
    check(fifth.status === 200 && sixth.status === 429, 'at most 5 codes an hour, even after cancelling', `5th HTTP ${fifth.status}, 6th HTTP ${sixth.status}`);

    let last;
    for (let i = 0; i < 5; i++) last = await call('POST', '/api/settings/email/verify', token, { code: String(100000 + i) });
    const afterMax = await call('POST', '/api/settings/email/verify', token, { code: '999999' });
    check(last.status === 429 && afterMax.status === 429, 'after 5 wrong codes the code is dead', last.json.error);
    // Put the confirmed address back for the fan-out checks (the cancel above turned it off).
    await pool.query('UPDATE sellers SET alert_email = ? WHERE id = ?', [address, sellerId]);

    console.log('\n2. Telegram');
    const link = await call('POST', '/api/settings/telegram', token);
    const linkUrl = link.json?.url && new URL(link.json.url);
    const startCode = linkUrl?.searchParams.get('start');
    check(link.status === 200 && linkUrl.origin === 'https://t.me' && linkUrl.pathname === '/aiops_test_bot' && /^[A-Za-z0-9_-]{16}$/.test(startCode), 'one-time bot link', link.json?.url?.replace(startCode, '<code>'));

    telegram.startTelegramPolling();
    tg.queue.push({ update_id: 10, message: { chat: { id: 4242 }, text: `/start ${startCode}` } });
    const welcome = await until(() => tg.sent.find((m) => m.chat_id === 4242));
    check(/Connected to Alerts Test/.test(welcome?.text || ''), 'pressing Start links the chat (via the polling loop)', welcome?.text);
    check((await call('GET', '/api/settings', token)).json.telegram.connected === true, 'settings: Telegram on');

    tg.queue.push({ update_id: 11, message: { chat: { id: 9999 }, text: `/start ${startCode}` } });
    const reused = await until(() => tg.sent.find((m) => m.chat_id === 9999));
    check(/expired or was already used/.test(reused?.text || ''), 'the same link cannot link a second chat');
    tg.queue.push({ update_id: 12, message: { chat: { id: 5555 }, text: 'hello?' } });
    const help = await until(() => tg.sent.find((m) => m.chat_id === 5555));
    check(/Connect Telegram/.test(help?.text || ''), 'other messages get a how-to reply');

    console.log('\n3. Alerts go to every channel');
    const before = { mails: smtp.messages.length, tgs: tg.sent.length };
    const test = await call('POST', '/api/settings/test-alert', token);
    const results = Object.fromEntries((test.json?.results || []).map((r) => [r.channel, r.ok]));
    check(test.status === 200 && results.email === true && results.telegram === true, 'test alert: email + Telegram', JSON.stringify(test.json?.results));

    await postDecision(sellerId, '*New order #1001*\nHOLD - out of stock\n- Snowboard: 2 short');
    const alertMail = await until(() => smtp.messages.slice(before.mails).find((m) => /Subject: AI Ops: New order #1001: HOLD/.test(m.raw)));
    check(Boolean(alertMail), 'email subject names the order and verdict');
    check(!/\*/.test(alertMail?.raw.split('\n\n').slice(1).join('\n') || '*'), 'email body is plain text (no Slack *bold*)');
    const alertTg = tg.sent.slice(before.tgs).find((m) => /New order #1001/.test(m.text));
    check(alertTg && !alertTg.text.includes('*') && alertTg.chat_id === '4242', 'Telegram gets it as plain text in the linked chat');

    process.env.SMTP_URL = 'smtp://127.0.0.1:1'; // nothing listens there
    const partial = await postDecision(sellerId, '*Low stock: Mug*\nRESTOCK - 1 left');
    const byChannel = Object.fromEntries(partial.map((r) => [r.channel, r]));
    check(byChannel.email?.ok === false && byChannel.telegram?.ok === true, 'email down -> Telegram still sent', `email error: ${byChannel.email?.error}`);
    process.env.SMTP_URL = `smtp://127.0.0.1:${smtp.port}`;

    tg.queue.push({ update_id: 13, message: { chat: { id: 4242 }, text: '/stop' } });
    const stopped = await until(() => tg.sent.find((m) => m.chat_id === 4242 && /turned off/.test(m.text)));
    check(Boolean(stopped) && (await call('GET', '/api/settings', token)).json.telegram.connected === false, '/stop in the chat turns Telegram off');

    await call('DELETE', '/api/settings/email', token);
    check((await call('GET', '/api/settings', token)).json.email_alerts.address === null, 'email alerts can be turned off');
  } finally {
    telegram.stopTelegramPolling();
    await pool.query('DELETE FROM channel_links WHERE seller_id = ?', [sellerId]);
    await pool.query('DELETE FROM sellers WHERE id = ?', [sellerId]);
    console.log('\nRemoved the test seller.');
    await wait(400); // let the last getUpdates return
    server.close();
    smtp.server.close();
    tg.server.close();
    await pool.end();
  }
}

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.stack || err.message}`);
    failures++;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
  });
