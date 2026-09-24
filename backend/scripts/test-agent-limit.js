// End-to-end check of the daily agent limits, run in-process against a fake
// DeepSeek on localhost (no real LLM call; the real database is used with a
// throwaway seller):
//   1. under the account's limit: each run calls the model and is counted
//   2. at the account's limit: the event is saved as SKIPPED, no model call
//   3. at the total limit (all accounts together): the same
//   4. without an API key: the run fails before anything is counted
//
// Usage:  npm run test:agent-limit
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const http = require('http');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- a fake DeepSeek: answers every chat completion with a RESTOCK verdict and no tool calls ---
function startFakeLLM() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fake-completion',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'deepseek-chat',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'RESTOCK - fake agent reply\n- Test Mug: 1 left' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

async function main() {
  const llm = await startFakeLLM();
  // Set before anything loads the .env: real environment variables win over
  // it, so the real DeepSeek key and endpoint can't be used by accident.
  Object.assign(process.env, {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.port}`,
  });
  require('dotenv').config({ quiet: true });
  process.env.MCP_SERVER_PATH ||= path.join(__dirname, '..', '..', 'mcp', 'server.js');

  const pool = require('../src/config/db');
  const { runAgent } = require('../src/services/agentService');

  const [created] = await pool.query(
    "INSERT INTO sellers (business_name, email, password_hash) VALUES ('Agent limit test', ?, 'not-a-real-hash')",
    [`agent-limit-${Date.now()}@example.test`]
  );
  const sellerId = created.insertId;
  const trigger = { type: 'low_stock_crossed', items: [{ item_name: 'Test Mug', stock_quantity: 1, low_stock_threshold: 5 }] };
  const decisions = async () =>
    (await pool.query('SELECT action_taken, reasoning FROM decisions WHERE seller_id = ? ORDER BY id', [sellerId]))[0];
  const countedRuns = async () =>
    Number((await pool.query('SELECT COUNT(*) AS n FROM agent_runs WHERE seller_id = ?', [sellerId]))[0][0].n);

  try {
    console.log('\n1. Under the account limit (2 a day)');
    process.env.AGENT_DAILY_LIMIT_PER_ACCOUNT = '2';
    process.env.AGENT_DAILY_LIMIT_TOTAL = '100000';
    await runAgent(sellerId, trigger);
    await runAgent(sellerId, trigger);
    check(llm.requests.length === 2, 'two runs, two model calls', `${llm.requests.length} call(s)`);
    check(llm.requests.every((r) => r.url.endsWith('/chat/completions')), 'the calls went to the fake DeepSeek');
    check((await countedRuns()) === 2, 'both runs counted');
    let rows = await decisions();
    check(rows.length === 2 && rows.every((d) => d.action_taken === 'low_stock_alert'), "both saved with the agent's RESTOCK verdict");

    console.log('\n2. At the account limit');
    await runAgent(sellerId, trigger);
    check(llm.requests.length === 2, 'no model call', `${llm.requests.length} call(s)`);
    check((await countedRuns()) === 2, 'the skipped run is not counted');
    rows = await decisions();
    check(
      rows.length === 3 && rows[2].action_taken === 'skipped' && /its 2 agent checks/.test(rows[2].reasoning),
      'saved as SKIPPED, naming the account limit',
      rows[2]?.reasoning.split('\n')[0]
    );

    console.log('\n3. At the total limit');
    process.env.AGENT_DAILY_LIMIT_PER_ACCOUNT = '100';
    const [[{ n: totalToday }]] = await pool.query('SELECT COUNT(*) AS n FROM agent_runs WHERE started_at > NOW() - INTERVAL 1 DAY');
    process.env.AGENT_DAILY_LIMIT_TOTAL = String(totalToday);
    await runAgent(sellerId, trigger);
    check(llm.requests.length === 2, 'no model call', `${llm.requests.length} call(s)`);
    rows = await decisions();
    check(
      rows[3]?.action_taken === 'skipped' && /service's daily limit/.test(rows[3].reasoning),
      'saved as SKIPPED, naming the total limit',
      rows[3]?.reasoning.split('\n')[0]
    );
    process.env.AGENT_DAILY_LIMIT_TOTAL = String(Number(totalToday) + 1);
    await runAgent(sellerId, trigger);
    check(llm.requests.length === 3, 'with room for one more, the next run calls the model again', `${llm.requests.length} call(s)`);

    console.log('\n4. Without an API key');
    delete process.env.DEEPSEEK_API_KEY;
    const before = await countedRuns();
    let error = null;
    try {
      await runAgent(sellerId, trigger);
    } catch (err) {
      error = err;
    }
    check(Boolean(error) && (await countedRuns()) === before, 'fails before a run is counted', error?.message);
  } finally {
    await pool.query('DELETE FROM decisions WHERE seller_id = ?', [sellerId]);
    await pool.query('DELETE FROM sellers WHERE id = ?', [sellerId]); // its agent_runs go with it
    llm.server.close();
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
