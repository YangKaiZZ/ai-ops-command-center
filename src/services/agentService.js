const { OpenAI } = require('openai');
const { connectAsSeller } = require('./mcpClient');
const { postDecision } = require('./notifier');
const { saveDecision, actionFromReasoning } = require('../models/decisionModel');
const { checkOrderStock } = require('./stockCheck');

// DeepSeek speaks the OpenAI Chat Completions API, so the OpenAI SDK works
// as-is once it's pointed at their endpoint.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-chat';
const MAX_STEPS = 6; // hard stop so a confused model can't loop on tool calls forever

const SYSTEM_PROMPT = `You are the operations assistant for a Shopify seller.
You are triggered by store events and must decide what the seller should do.
Use your tools for context (other pending orders, low stock) - never guess stock levels.

How to read the data:
- A new order comes with a stock check for each line item (stock_on_hand, can_ship), computed
  from this store's inventory. It is final: if any line item has can_ship: false, the verdict is HOLD.
  Don't second-guess it - never assume an item (gift cards, digital goods) needs no stock.
  stock_on_hand "not tracked" means the store doesn't limit that item's stock.
- check_low_stock returns items at or below their low-stock threshold, keyed by shopify_variant_id.
  Its stock_quantity values are authoritative.

Reply in plain text for a Slack message, under 80 words:
Line 1: one verdict followed by a short headline. The verdict is saved to the dashboard, so use exactly:
- for a new order: FULFILL if every item can ship now, otherwise HOLD (mention any restock need in the bullets)
- for a low-stock event: RESTOCK
Then 2-4 bullets with the specific reasons (item names, quantities, stock numbers).`;

// Turns the raw trigger into the user message the model sees. Orders need
// the stock check from checkOrderStock().
function describeTrigger(trigger, stockCheck) {
  if (trigger.type === 'order_created') {
    const o = trigger.order;
    const summary = stockCheck.canShip
      ? 'Stock check: every line item can ship.'
      : `Stock check: ${stockCheck.short.length} line item(s) CANNOT ship - verdict must be HOLD.`;
    return `A new order was just placed. Decide whether it can be fulfilled now.\n${summary}\n${JSON.stringify(
      { order: o.name, financial_status: o.financial_status, total: o.total_price, line_items: stockCheck.lines },
      null,
      2
    )}`;
  }

  if (trigger.type === 'low_stock_crossed') {
    return `An inventory sync just pushed these items to or below their low-stock threshold. Decide what the seller should restock, and whether pending orders are at risk.\n${JSON.stringify(
      trigger.items,
      null,
      2
    )}`;
  }

  throw new Error(`Unknown trigger type: ${trigger.type}`);
}

// Backstop: if the model still says anything but HOLD for an order that
// can't ship, the stock data wins — the dashboard and Slack must match inventory.
function enforceStockCheck(reasoning, stockCheck) {
  if (!stockCheck || stockCheck.canShip || actionFromReasoning(reasoning) === 'hold') {
    return { reasoning, overridden: false };
  }
  const short = stockCheck.short.map((l) => `${l.title} (${l.quantity} ordered, ${l.stock_on_hand} on hand)`).join('; ');
  return {
    reasoning: `HOLD - stock check: ${short}\n(The agent's reply below disagreed; stock data wins.)\n\n${reasoning || ''}`,
    overridden: true,
  };
}

function headline(trigger) {
  if (trigger.type === 'order_created') return `New order ${trigger.order.name}`;
  return `Low stock: ${trigger.items.map((i) => i.item_name).join(', ')}`;
}

// MCP tool definitions -> OpenAI function-calling format.
function toOpenAITools(mcpTools) {
  return mcpTools.map((t) => {
    const { $schema, ...parameters } = t.inputSchema || {};
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: {}, ...parameters },
      },
    };
  });
}

function createLLMClient() {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is not set in .env - skipping the LLM call');
  }
  return new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: DEEPSEEK_BASE_URL });
}

// The agent loop: give the model the event + the MCP tools, execute whatever
// tools it asks for, feed results back, repeat until it answers in text.
async function runAgent(sellerId, trigger) {
  const tag = `[agent seller=${sellerId} ${trigger.type}]`;
  const mcp = await connectAsSeller(sellerId);

  try {
    console.log(`${tag} MCP tools: ${mcp.tools.map((t) => t.name).join(', ')}`);
    const llm = createLLMClient();
    const tools = toOpenAITools(mcp.tools);
    const stockCheck = trigger.type === 'order_created' ? await checkOrderStock(sellerId, trigger.order) : null;
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: describeTrigger(trigger, stockCheck) },
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await llm.chat.completions.create({ model: DEEPSEEK_MODEL, messages, tools });
      const msg = completion.choices[0].message;
      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      if (!msg.tool_calls?.length) {
        const { reasoning, overridden } = enforceStockCheck(msg.content, stockCheck);
        if (overridden) console.warn(`${tag} model ignored the stock check - recorded as HOLD`);

        // Save before posting, so a Slack outage can't lose the decision. A DB
        // failure shouldn't silence the alert either, so it's only logged.
        try {
          const saved = await saveDecision(sellerId, trigger, reasoning);
          console.log(`${tag} decision #${saved.id} saved (${saved.actionTaken})`);
        } catch (err) {
          console.error(`${tag} could not save decision: ${err.message}`);
        }

        const decision = `*${headline(trigger)}*\n${reasoning}`;
        await postDecision(sellerId, decision);
        return decision;
      }

      for (const call of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // Model sent malformed JSON args; our tools take none anyway.
        }
        const result = await mcp.callTool(call.function.name, args);
        console.log(`${tag} tool ${call.function.name}${result.isError ? ' ERROR' : ''} (${result.text.length} chars)`);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.isError ? `ERROR: ${result.text}` : result.text,
        });
      }
    }

    throw new Error(`gave up after ${MAX_STEPS} steps without a decision`);
  } finally {
    await mcp.close();
  }
}

// Fire-and-forget wrapper for request handlers: the HTTP response has already
// gone out (Shopify wants a reply within 5s), so failures just get logged.
function triggerAgent(sellerId, trigger) {
  runAgent(sellerId, trigger).catch((err) => {
    console.error(`[agent seller=${sellerId} ${trigger.type}] failed: ${err.message}`);
  });
}

module.exports = { runAgent, triggerAgent, describeTrigger, enforceStockCheck, toOpenAITools, createLLMClient };
