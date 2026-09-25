// End-to-end check that the agent learns from the seller's ratings, run
// in-process against a fake DeepSeek on localhost (no real LLM call; the real
// database is used with throwaway sellers, removed at the end):
//   1. an order run gets the seller's ratings of earlier order calls: every
//      one marked wrong, those marked right with a note, newest first; not
//      unrated ones, ratings over 90 days old, low-stock calls or another
//      seller's; and the system prompt says how to use them
//   2. a low-stock run gets only the ratings of low-stock calls
//   3. at most 8, the newest
//   4. a seller with no ratings: no feedback in the prompt
//
// Usage:  npm run test:agent-feedback
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const http = require('http');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failures++;
};

// --- a fake DeepSeek: records each request, answers with a verdict and no tool calls ---
function startFakeLLM() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      requests.push(parsed);
      const isOrder = /A new order was just placed/.test(parsed.messages?.[1]?.content || '');
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
              message: { role: 'assistant', content: isOrder ? 'FULFILL - fake reply\n- ok' : 'RESTOCK - fake reply\n- ok' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

// The ratings the agent was given in a request's user message, or null.
function ratingsSent(request) {
  const text = request?.messages?.[1]?.content || '';
  const marker = "The seller's ratings of your recent calls on events like this one, newest first:\n";
  const at = text.indexOf(marker);
  return at === -1 ? null : JSON.parse(text.slice(at + marker.length));
}

async function main() {
  const llm = await startFakeLLM();
  // Set before anything loads the .env: real environment variables win over
  // it, so the real DeepSeek key and endpoint can't be used by accident.
  Object.assign(process.env, {
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${llm.port}`,
    AGENT_DAILY_LIMIT_PER_ACCOUNT: '100',
    AGENT_DAILY_LIMIT_TOTAL: '100000',
  });
  require('dotenv').config({ quiet: true });
  process.env.MCP_SERVER_PATH ||= path.join(__dirname, '..', '..', 'mcp', 'server.js');

  const pool = require('../src/config/db');
  const { runAgent } = require('../src/services/agentService');
  const sellerIds = [];
  const addSeller = async (name) => {
    const [r] = await pool.query("INSERT INTO sellers (business_name, email, password_hash) VALUES (?, ?, 'x')", [
      name,
      `agent-feedback-${Date.now()}-${sellerIds.length}@example.test`,
    ]);
    sellerIds.push(r.insertId);
    return r.insertId;
  };
  // A past decision and its rating, `ratedDaysAgo` days ago.
  const addRated = (sellerId, { number = null, action, reasoning, feedback = null, note = null, ratedDaysAgo = 1 }) =>
    pool.query(
      `INSERT INTO decisions (seller_id, order_number, reasoning, action_taken, created_at, feedback, feedback_note, feedback_at)
       VALUES (?, ?, ?, ?, NOW() - INTERVAL ? MINUTE, ?, ?, IF(? IS NULL, NULL, NOW() - INTERVAL ? MINUTE))`,
      [sellerId, number, reasoning, action, Math.round((ratedDaysAgo + 0.5) * 1440), feedback, note, feedback, Math.round(ratedDaysAgo * 1440)]
    );
  const orderTrigger = (n) => ({
    type: 'order_created',
    order: { id: 990000 + n, name: `#${3000 + n}`, financial_status: 'pending', total_price: '10.00', line_items: [{ variant_id: null, title: 'Gift wrap', quantity: 1 }] },
  });
  const lowStockTrigger = { type: 'low_stock_crossed', items: [{ item_name: 'Linen Scarf', stock_quantity: 2, low_stock_threshold: 5 }] };

  try {
    const seller = await addSeller('main');
    await addRated(seller, { number: '#2001', action: 'hold', reasoning: 'HOLD - Payment still pending\n- wait', feedback: 'down', note: 'Bank transfers always show pending first; ship them.', ratedDaysAgo: 1 });
    await addRated(seller, { number: '#2002', action: 'fulfill', reasoning: 'FULFILL - All in stock', feedback: 'down', ratedDaysAgo: 2 });
    await addRated(seller, { number: '#2003', action: 'fulfill', reasoning: 'FULFILL - Regular customer', feedback: 'up', note: 'Right: regulars get shipped first.', ratedDaysAgo: 3 });
    await addRated(seller, { number: '#2004', action: 'fulfill', reasoning: 'FULFILL - fine', feedback: 'up', ratedDaysAgo: 1 }); // right, no note: nothing to learn
    await addRated(seller, { number: '#2005', action: 'hold', reasoning: 'HOLD - unrated' }); // not rated
    await addRated(seller, { number: '#2006', action: 'hold', reasoning: 'HOLD - long ago', feedback: 'down', note: 'too old', ratedDaysAgo: 100 });
    await addRated(seller, { action: 'low_stock_alert', reasoning: 'RESTOCK - Linen Scarf low\n- reorder 12', feedback: 'down', note: 'We reorder scarves by the 50.', ratedDaysAgo: 1 });
    const other = await addSeller('other');
    await addRated(other, { number: '#2001', action: 'hold', reasoning: 'HOLD - other store', feedback: 'down', note: "Another seller's note", ratedDaysAgo: 0.5 });

    console.log('\n1. An order run');
    await runAgent(seller, orderTrigger(1));
    let request = llm.requests.at(-1);
    let sent = ratingsSent(request);
    check(/seller's ratings of your recent calls/.test(request?.messages?.[0]?.content) && /never override the stock check/.test(request.messages[0].content), 'the system prompt says how to use the ratings');
    check(/A new order was just placed/.test(request?.messages?.[1]?.content), 'the ratings follow the event in the same message');
    check(
      JSON.stringify(sent?.map((r) => r.order)) === JSON.stringify(['#2001', '#2002', '#2003']),
      'wrong calls and right calls with a note, newest first',
      JSON.stringify(sent?.map((r) => r.order))
    );
    check(
      sent?.[0]?.your_call === 'HOLD - Payment still pending' && sent[0].seller_says === 'wrong call' && sent[0].seller_note === 'Bank transfers always show pending first; ship them.',
      'each with the call, the rating and the note',
      JSON.stringify(sent?.[0])
    );
    check(sent?.[1] && !('seller_note' in sent[1]) && sent[2]?.seller_says === 'right call', 'a wrong call without a note still counts; a right call says so');
    const everything = JSON.stringify(request?.messages || []);
    check(!/too old|unrated|scarves by the 50|Another seller's note/.test(everything), 'not unrated calls, ratings over 90 days old, low-stock calls or another seller\'s');
    const [[saved]] = await pool.query('SELECT action_taken FROM decisions WHERE seller_id = ? AND order_number = ?', [seller, '#3001']);
    check(saved?.action_taken === 'fulfill', 'the run still saves its decision', saved?.action_taken);

    console.log('\n2. A low-stock run');
    await runAgent(seller, lowStockTrigger);
    sent = ratingsSent(llm.requests.at(-1));
    check(sent?.length === 1 && sent[0].seller_note === 'We reorder scarves by the 50.' && !('order' in sent[0]), 'only the ratings of low-stock calls', JSON.stringify(sent));

    console.log('\n3. At most 8');
    for (let i = 0; i < 7; i++) {
      await addRated(seller, { number: `#21${i}`, action: 'fulfill', reasoning: `FULFILL - batch ${i}`, feedback: 'down', note: `note ${i}`, ratedDaysAgo: 0.1 + i * 0.01 });
    }
    await runAgent(seller, orderTrigger(2));
    sent = ratingsSent(llm.requests.at(-1));
    check(
      sent?.length === 8 && sent[0].order === '#210' && sent[6].order === '#216' && sent[7].order === '#2001',
      'the 8 newest ratings',
      JSON.stringify(sent?.map((r) => r.order))
    );

    console.log('\n4. No ratings');
    const fresh = await addSeller('fresh');
    await runAgent(fresh, orderTrigger(3));
    request = llm.requests.at(-1);
    check(ratingsSent(request) === null && !/ratings of your recent calls on events/.test(request?.messages?.[1]?.content), 'no feedback in the prompt');
  } finally {
    llm.server.close();
    if (sellerIds.length) {
      await pool.query('DELETE FROM decisions WHERE seller_id IN (?)', [sellerIds]);
      await pool.query('DELETE FROM sellers WHERE id IN (?)', [sellerIds]); // their agent_runs and API keys go with them
    }
    console.log('\nRemoved the test sellers and their decisions.');
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
