const pool = require('../config/db');
const { connectAsSeller, AGENT_TOOLS } = require('./mcpClient');
const { toOpenAITools, createLLMClient } = require('./agentService');
const aiModel = require('./aiModel');
const { readLimit } = require('./agentBudget');
const rateLimit = require('./rateLimit');
const { localDate } = require('../utils/timeZone');

// Chat in the dashboard: the seller asks about their store in their own
// words, and the model answers with the same MCP tools the agent and Claude
// Desktop use. Read-only: nothing here syncs, rates, holds or ships. The
// conversation lives in the seller's browser; the server keeps no copy.

// What the chat may call: the agent's tools plus the decision history.
const CHAT_TOOLS = [...AGENT_TOOLS, 'get_decisions'];
const MAX_STEPS = 6; // model calls per question, like the agent
const MAX_MESSAGES = 20; // of the conversation sent with each question
const MAX_MESSAGE_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 12000; // a long order list is cut, and the model is told

// Questions per day, counted in rate_limit_events: per account, and in total
// so many accounts can't run up the model bill. Separate from the agent's
// caps, so chatting never uses up the checks new orders need. 0 turns it off.
function limits() {
  return {
    perAccount: { bucket: 'chat:account', max: readLimit('CHAT_DAILY_LIMIT_PER_ACCOUNT', 40), windowSeconds: 24 * 60 * 60 },
    total: { bucket: 'chat:total', max: readLimit('CHAT_DAILY_LIMIT_TOTAL', 400), windowSeconds: 24 * 60 * 60 },
  };
}

const SYSTEM_PROMPT = `You are the operations assistant inside a Shopify seller's dashboard. The seller asks about
their store; answer from their data, which your tools read. Never guess numbers, stock levels, order
details or dates: look them up, and if the tools don't have something, say so.

- Orders: get_pending_orders (still to ship), get_all_orders (filters by status, payment, dates), get_order
  (one order with the agent's reasoning). Each order can carry Shopify's fraud check (risk).
- Stock: check_low_stock (at or below the threshold), forecast_restock (when items run out, how much to
  reorder; say what the forecast is based on, and call a "low" confidence one a rough estimate).
- The agent's past calls on orders and stock: get_decisions (with the seller's ratings and notes).

You can't change anything: no syncing, holding, shipping or rating. When the seller wants that, tell them
where in the dashboard to do it (an order's page has "In Shopify" for hold and fulfill; Settings has sync).
Answer in plain text: short, specific, with order numbers, item names and figures. Use "- " bullets for
lists; no tables, headings or bold. Dates are in the seller's time zone.`;

// The conversation as the client sent it, checked. Returns { messages } or { error }.
function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return { error: 'messages must be a non-empty list' };
  const messages = input.slice(-MAX_MESSAGES);
  for (const m of messages) {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) {
      return { error: 'each message needs a role (user or assistant) and some text' };
    }
    if (m.content.length > MAX_MESSAGE_CHARS) return { error: `a message can be at most ${MAX_MESSAGE_CHARS} characters` };
  }
  if (messages.at(-1).role !== 'user') return { error: 'the last message must be the question' };
  // Kept to role and text: nothing else from the client reaches the model.
  return { messages: messages.map((m) => ({ role: m.role, content: m.content.trim() })) };
}

// Seconds until the seller may ask again (0 = now), and which cap: 'account' or 'total'.
async function waitFor(sellerId) {
  const { perAccount, total } = limits();
  const account = await rateLimit.secondsUntilAllowed(perAccount, sellerId);
  if (account) return { seconds: account, cap: 'account' };
  const all = await rateLimit.secondsUntilAllowed(total, 'all');
  if (all) return { seconds: all, cap: 'total' };
  return { seconds: 0, cap: null };
}

// What the chat page shows: whether it can be used, and today's questions.
async function status(sellerId) {
  const { perAccount } = limits();
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM rate_limit_events WHERE bucket = ? AND subject = ? AND created_at > NOW() - INTERVAL ? SECOND',
    [perAccount.bucket, rateLimit.subjectKey(perAccount, sellerId), perAccount.windowSeconds]
  );
  return {
    available: aiModel.isConfigured() && perAccount.max > 0,
    daily_limit: perAccount.max,
    used_today: Math.min(Number(row.n), perAccount.max),
  };
}

// "Today is 2026-09-28 (time zone Asia/Manila)." for the system prompt.
async function todayLine(sellerId) {
  const [[seller]] = await pool.query('SELECT timezone FROM sellers WHERE id = ?', [sellerId]);
  const zone = seller?.timezone || 'UTC';
  return `Today is ${localDate(new Date(), zone)} (time zone ${zone}).`;
}

// Answers the last question in `messages` (validateMessages). Counts it
// against the daily caps first. Returns { reply, tools_used }.
async function answer(sellerId, messages) {
  const llm = createLLMClient(); // throws when no model key is set, before anything is counted
  const { perAccount, total } = limits();
  await rateLimit.record(perAccount, sellerId);
  await rateLimit.record(total, 'all');

  const mcp = await connectAsSeller(sellerId, { tools: CHAT_TOOLS });
  try {
    const tools = toOpenAITools(mcp.tools);
    const conversation = [{ role: 'system', content: `${SYSTEM_PROMPT}\n${await todayLine(sellerId)}` }, ...messages];
    const toolsUsed = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await llm.chat.completions.create({ ...aiModel.completionOptions(), messages: conversation, tools });
      const msg = completion.choices[0].message;
      if (!msg.tool_calls?.length) {
        return { reply: (msg.content || '').trim() || "Sorry, I couldn't come up with an answer. Try asking another way.", tools_used: toolsUsed };
      }

      conversation.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // Malformed arguments: call with none, so the tool uses its defaults.
        }
        const result = await mcp.callTool(call.function.name, args);
        if (!toolsUsed.includes(call.function.name)) toolsUsed.push(call.function.name);
        let text = result.isError ? `ERROR: ${result.text}` : result.text;
        if (text.length > MAX_TOOL_RESULT_CHARS) {
          text = `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[cut: the result was ${text.length} characters. Ask for fewer, e.g. with limit or a date range.]`;
        }
        conversation.push({ role: 'tool', tool_call_id: call.id, content: text });
      }
    }
    return {
      reply: `I looked through ${toolsUsed.join(', ')} but couldn't finish an answer. Try a narrower question, e.g. one order or a shorter date range.`,
      tools_used: toolsUsed,
    };
  } finally {
    await mcp.close();
  }
}

module.exports = { answer, status, waitFor, validateMessages, limits, CHAT_TOOLS, SYSTEM_PROMPT, MAX_MESSAGES };
