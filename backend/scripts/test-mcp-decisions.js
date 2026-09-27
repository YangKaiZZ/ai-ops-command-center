// End-to-end check of the MCP tools that read and rate the agent's decisions,
// driven like Claude Desktop does: the real MCP server as a subprocess, with
// an API key, against the backend in-process. The real database is used with
// throwaway sellers, removed at the end:
//   1. get_decisions: newest first, headlines or full reasoning, the ratings,
//      filters (not rated yet, rated wrong, one order), only this seller's
//   2. rate_decision: right, wrong with a note, clearing; a skipped run and
//      another seller's decision are refused
//   3. the agent itself doesn't get either tool
//
// Usage:  npm run test:mcp-decisions
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const crypto = require('crypto');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  require('dotenv').config({ quiet: true });
  const MCP_SERVER = path.join(__dirname, '..', '..', 'mcp', 'server.js');
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const app = require('../src/app');
  const pool = require('../src/config/db');
  const { createApiKey } = require('../src/models/apiKeyModel');

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const run = crypto.randomBytes(3).toString('hex');
  const sellerIds = [];
  const addSeller = async (name) => {
    const [r] = await pool.query("INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, 'x')", [name, `mcpdec-${run}-${name}@example.test`]);
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  const addDecision = async (sellerId, number, reasoning, action, minutesAgo, feedback = null, note = null) =>
    (
      await pool.query(
        `INSERT INTO decisions (seller_id, order_number, reasoning, action_taken, created_at, feedback, feedback_note, feedback_at)
         VALUES (?, ?, ?, ?, NOW() - INTERVAL ? MINUTE, ?, ?, IF(? IS NULL, NULL, NOW()))`,
        [sellerId, number, reasoning, action, minutesAgo, feedback, note, feedback]
      )
    )[0].insertId;

  let client;
  try {
    const seller = await addSeller('main');
    const other = await addSeller('other');
    const { key } = await createApiKey(seller, 'mcp decisions test');
    const oldest = await addDecision(seller, '#5001', 'FULFILL - paid, in stock\n- all items ship', 'fulfill', 60, 'up');
    const wrong = await addDecision(seller, '#5002', 'HOLD - payment pending\n- bank transfer', 'hold', 50, 'down', 'Bank transfers always show pending first; ship them.');
    const unrated = await addDecision(seller, '#5003', 'HOLD - fraud check: high risk\n- card declined 4 times', 'hold', 40);
    const skipped = await addDecision(seller, '#5004', 'SKIPPED - daily limit reached', 'skipped', 30);
    const lowStock = await addDecision(seller, null, 'RESTOCK - Linen scarf: 2 left', 'low_stock_alert', 20);
    const othersDecision = await addDecision(other, '#9001', 'FULFILL - ok', 'fulfill', 10);

    client = new Client({ name: 'mcp-decisions-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [MCP_SERVER],
        env: { ...getDefaultEnvironment(), BACKEND_URL: `http://localhost:${port}`, BACKEND_API_KEY: key },
        stderr: 'ignore',
      })
    );
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content?.[0]?.text ?? '';
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // plain text
      }
      return { isError: Boolean(result.isError), text, json };
    };

    const { tools } = await client.listTools();
    check(['get_decisions', 'rate_decision'].every((n) => tools.some((t) => t.name === n)), 'Claude Desktop gets get_decisions and rate_decision', tools.map((t) => t.name).join(', '));

    console.log('\n1. get_decisions');
    let r = await call('get_decisions');
    const ids = r.json?.decisions?.map((d) => d.id);
    check(JSON.stringify(ids) === JSON.stringify([lowStock, skipped, unrated, wrong, oldest]), 'newest first, only this seller\'s', JSON.stringify(ids));
    const first = r.json?.decisions?.find((d) => d.id === wrong);
    check(
      first?.verdict === 'hold' && first.headline === 'HOLD - payment pending' && first.rating === 'wrong' && first.note === 'Bank transfers always show pending first; ship them.' && !('reasoning' in first),
      'each with its verdict, headline, rating and note',
      JSON.stringify(first)
    );
    check(r.json?.ratings?.up === 1 && r.json.ratings.down === 1, 'and the ratings so far', JSON.stringify(r.json?.ratings));
    r = await call('get_decisions', { show: 'unrated' });
    check(JSON.stringify(r.json?.decisions?.map((d) => d.id)) === JSON.stringify([lowStock, unrated]), 'show unrated: not rated yet, skipped runs left out', JSON.stringify(r.json?.decisions?.map((d) => d.id)));
    r = await call('get_decisions', { show: 'wrong' });
    check(r.json?.decisions?.length === 1 && r.json.decisions[0].id === wrong, 'show wrong: rated wrong');
    r = await call('get_decisions', { order_number: '5003', with_reasoning: true });
    check(
      r.json?.decisions?.length === 1 && r.json.decisions[0].reasoning === 'HOLD - fraud check: high risk\n- card declined 4 times',
      'one order (with or without "#"), with the full reasoning',
      JSON.stringify(r.json?.decisions)
    );
    r = await call('get_decisions', { limit: 2 });
    check(r.json?.decisions?.length === 2 && r.json.matching === 5, 'limit, with how many matched', `${r.json?.decisions?.length} of ${r.json?.matching}`);

    console.log('\n2. rate_decision');
    r = await call('rate_decision', { decision_id: unrated, rating: 'right' });
    let [[row]] = await pool.query('SELECT feedback, feedback_note FROM decisions WHERE id = ?', [unrated]);
    check(!r.isError && r.text === `Saved: decision ${unrated} rated right.` && row.feedback === 'up', 'rated right', r.text);
    r = await call('rate_decision', { decision_id: unrated, rating: 'wrong', note: 'This customer is a regular; call them first.' });
    [[row]] = await pool.query('SELECT feedback, feedback_note FROM decisions WHERE id = ?', [unrated]);
    check(row.feedback === 'down' && row.feedback_note === 'This customer is a regular; call them first.' && /with the note/.test(r.text), 'rated wrong, with a note the agent will read', r.text);
    r = await call('rate_decision', { decision_id: unrated, rating: 'clear' });
    [[row]] = await pool.query('SELECT feedback, feedback_note FROM decisions WHERE id = ?', [unrated]);
    check(row.feedback === null && row.feedback_note === null && r.text === `Cleared the rating of decision ${unrated}.`, 'cleared', r.text);
    r = await call('rate_decision', { decision_id: skipped, rating: 'wrong' });
    check(r.isError && /skipped run has no verdict/.test(r.text), 'a skipped run is refused', r.text);
    r = await call('rate_decision', { decision_id: othersDecision, rating: 'wrong' });
    const [[others]] = await pool.query('SELECT feedback FROM decisions WHERE id = ?', [othersDecision]);
    check(r.isError && /Decision not found/.test(r.text) && others.feedback === null, "another seller's decision is not found, and not rated", r.text);
    r = await call('rate_decision', { decision_id: oldest, rating: 'maybe' });
    check(r.isError, 'a rating other than right, wrong or clear is refused', r.text.slice(0, 80));

    console.log('\n3. Not for the agent');
    process.env.PORT = String(port);
    process.env.MCP_SERVER_PATH = MCP_SERVER;
    const { connectAsSeller } = require('../src/services/mcpClient');
    const agentMcp = await connectAsSeller(seller);
    try {
      const names = agentMcp.tools.map((t) => t.name);
      check(!names.includes('get_decisions') && !names.includes('rate_decision'), "the agent doesn't get them", names.join(', '));
      const tried = await agentMcp.callTool('rate_decision', { decision_id: oldest, rating: 'wrong' });
      check(tried.isError && /not available to the agent/.test(tried.text), "and can't call rate_decision anyway", tried.text);
    } finally {
      await agentMcp.close();
    }
  } finally {
    await client?.close().catch(() => {});
    server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM api_keys WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]);
    }
    console.log('\nRemoved the test sellers, their decisions and API key.');
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
