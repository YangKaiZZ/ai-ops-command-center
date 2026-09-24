// End-to-end check of the sign-in and sign-up limits, run in-process with
// TRUST_PROXY=1 so each check can come from its own (documentation-range) IP
// address. The real database is used; test accounts and counters are removed.
//   1. one account: 10 failed sign-ins, then 429 with Retry-After, even with the right password
//   2. a success clears that account's failures
//   3. one address: 30 failures across many emails, then 429; another address still gets through
//   4. requests from this machine aren't limited by address
//   5. sign-ups: 10 per address per hour, then 429
//   6. an unknown email and a wrong password get the same answer
//
// Usage:  npm run test:rate-limits
const path = require('path');
process.chdir(path.join(__dirname, '..'));
process.env.SIGNUP_INVITE_CODE = ''; // these tests sign up without one
process.env.TRUST_PROXY = '1';

const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const { LIMITS, subjectKey } = require('../src/services/rateLimit');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const run = crypto.randomBytes(3).toString('hex');
  const used = []; // [limit, value] pairs, to remove their counters at the end
  const ip = () => {
    const address = `203.0.113.${crypto.randomInt(1, 255)}`;
    for (const limit of Object.values(LIMITS)) used.push([limit, address]);
    return address;
  };
  const email = (name) => {
    const address = `rl-${run}-${name}@example.test`;
    used.push([LIMITS.loginFailuresPerAccount, address]);
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
  const password = `pw-${run}-correct`;

  try {
    console.log('\n1. One account');
    const owner = email('owner');
    const signup = await post('register', { business_name: 'Rate limit test', email: owner, password }, ip());
    check(signup.status === 201, 'test account created');
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await post('login', { email: owner, password: 'wrong-password' }, ip())).status);
    check(statuses.every((s) => s === 401), '10 wrong passwords (from different addresses) get 401');
    let res = await post('login', { email: owner, password: 'wrong-password' }, ip());
    check(res.status === 429 && Number(res.retryAfter) > 800 && Number(res.retryAfter) <= 900, 'the 11th gets 429 with Retry-After', `${res.status}, Retry-After ${res.retryAfter}`);
    check(/Too many failed sign-in attempts\. Try again in about 15 minutes\./.test(res.body.error), 'with a message saying how long', res.body.error);
    res = await post('login', { email: owner, password }, ip());
    check(res.status === 429, 'the right password waits too');

    console.log('\n2. A success clears the count');
    const second = email('second');
    await post('register', { business_name: 'Rate limit test', email: second, password }, ip());
    for (let i = 0; i < 3; i++) await post('login', { email: second, password: 'wrong-password' }, ip());
    res = await post('login', { email: second, password }, ip());
    const [[left]] = await pool.query('SELECT COUNT(*) AS n FROM rate_limit_events WHERE bucket = ? AND subject = ?', [
      LIMITS.loginFailuresPerAccount.bucket,
      subjectKey(LIMITS.loginFailuresPerAccount, second),
    ]);
    check(res.status === 200 && Number(left.n) === 0, 'signing in clears the earlier failures', `${res.status}, ${left.n} left`);

    console.log('\n3. One address');
    const attacker = ip();
    const tries = [];
    for (let i = 0; i < 30; i++) tries.push((await post('login', { email: email(`guess${i}`), password: 'guess' }, attacker)).status);
    check(tries.every((s) => s === 401), '30 failures across different emails get 401');
    res = await post('login', { email: email('guess30'), password: 'guess' }, attacker);
    check(res.status === 429, 'the 31st from that address gets 429', String(res.status));
    res = await post('login', { email: second, password }, ip());
    check(res.status === 200, 'someone else, from another address, still signs in');

    console.log('\n4. This machine');
    const local = [];
    for (let i = 0; i < 31; i++) local.push((await post('login', { email: email(`local${i}`), password: 'guess' })).status);
    check(local.every((s) => s === 401), '31 failures from localhost are not limited by address');

    console.log('\n5. Sign-ups');
    const office = ip();
    const created = [];
    for (let i = 0; i < 10; i++) created.push((await post('register', { business_name: 'Rate limit test', email: email(`new${i}`), password }, office)).status);
    check(created.every((s) => s === 201), '10 sign-ups from one address work');
    res = await post('register', { business_name: 'Rate limit test', email: email('new10'), password }, office);
    check(res.status === 429 && /Too many new accounts/.test(res.body.error), 'the 11th gets 429', res.body.error);
    res = await post('register', { business_name: 'Rate limit test', email: email('elsewhere'), password }, ip());
    check(res.status === 201, 'from another address it works');

    console.log('\n6. No hint about which accounts exist');
    const unknown = await post('login', { email: email('nobody'), password: 'guess' }, ip());
    const wrong = await post('login', { email: second, password: 'guess' }, ip());
    check(unknown.status === 401 && wrong.status === 401 && unknown.body.error === wrong.body.error, 'same status and message', unknown.body.error);

    console.log('\n7. Invite code');
    process.env.SIGNUP_INVITE_CODE = `invite-${run}`;
    const guesser = ip();
    const signupBody = (name) => ({ business_name: 'Rate limit test', email: email(name), password });
    let cfg = await (await fetch(`${base}/api/auth/config`)).json();
    check(cfg.invite_required === true, 'config says a code is required');
    res = await post('register', signupBody('noinvite'), guesser);
    check(res.status === 403 && /Enter your invite code/.test(res.body.error), 'no code: 403', res.body.error);
    res = await post('register', { ...signupBody('wronginvite'), invite_code: 'not-it' }, guesser);
    check(res.status === 403 && /isn't right/.test(res.body.error), 'wrong code: 403', res.body.error);
    res = await post('register', { ...signupBody('goodinvite'), invite_code: ` invite-${run} ` }, guesser);
    check(res.status === 201, 'the right code creates the account');
    for (let i = 0; i < 8; i++) await post('register', { ...signupBody('g' + i), invite_code: 'guess' + i }, guesser);
    res = await post('register', { ...signupBody('lockedout'), invite_code: `invite-${run}` }, guesser);
    check(res.status === 429 && /wrong invite codes/.test(res.body.error), '10 wrong codes from one address lock guessing, even for the right one', res.body.error);
    res = await post('register', { ...signupBody('otherip'), invite_code: `invite-${run}` }, ip());
    check(res.status === 201, 'another address is unaffected');
    process.env.SIGNUP_INVITE_CODE = '';
    cfg = await (await fetch(`${base}/api/auth/config`)).json();
    check(cfg.invite_required === false, 'with no code set, config says so');
    res = await post('register', signupBody('open'), ip());
    check(res.status === 201, 'and sign-up needs none');
  } finally {
    server.close();
    await pool.query("DELETE FROM sellers WHERE business_name = 'Rate limit test' AND email LIKE ?", [`rl-${run}-%`]);
    for (const [limit, value] of used) {
      await pool.query('DELETE FROM rate_limit_events WHERE bucket = ? AND subject = ?', [limit.bucket, subjectKey(limit, value)]);
    }
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
