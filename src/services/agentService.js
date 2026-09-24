const { OpenAI } = require('openai');
const { connectAsSeller } = require('./mcpClient');
const { postDecision } = require('./notifier');
const { saveDecision } = require('../models/decisionModel');

// DeepSeek speaks the OpenAI Chat Completions API, so the OpenAI SDK works
// as-is once it's pointed at their endpoint.
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-chat';
const MAX_STEPS = 6; // hard stop so a confused model can't loop on tool calls forever

const SYSTEM_PROMPT = `You are the operations assistant for a Shopify seller.
You are triggered by store events and must decide what the seller should do.
Always check the data with your tools before deciding - never guess stock levels.

How to read the data:
- check_low_stock returns items at or below their low-stock threshold, keyed by shopify_variant_id.
  Everything it returns IS stock-tracked in this store and its stock_quantity is authoritative -
  never assume an item (gift cards, digital goods) is exempt from stock.
- An ordered variant that is NOT in the low-stock list either has stock above its threshold or
  isn't stock-tracked in Shopify; treat it as available.
- An order is not fulfillable if any line item's quantity is more than that variant's stock_quantity.

Reply in plain text for a Slack message, under 80 words:
Line 1: one verdict followed by a short headline. The verdict is saved to the dashboard, so use exactly:
- for a new order: FULFILL if every item can ship now, otherwise HOLD (mention any restock need in the bullets)
- for a low-stock event: RESTOCK
Then 2-4 bullets with the specific reasons (item names, quantities, stock numbers).`;

// Turns the raw trigger into the user message the model sees.
function describeTrigger(trigger) {
  if (trigger.type === 'order_created') {
    const o = trigger.order;
    const items = (o.line_items || []).map((li) => ({
      title: li.title,
      variant_title: li.variant_title,
      variant_id: li.variant_id != null ? String(li.variant_id) : null,
      quantity: li.quantity,
    }));
    return `A new order was just placed. Decide whether it can be fulfilled now.\n${JSON.stringify(
      { order: o.name, financial_status: o.financial_status, total: o.total_price, line_items: items },
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
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: describeTrigger(trigger) },
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await llm.chat.completions.create({ model: DEEPSEEK_MODEL, messages, tools });
      const msg = completion.choices[0].message;
      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      if (!msg.tool_calls?.length) {
        // Save before posting, so a Slack outage can't lose the decision. A DB
        // failure shouldn't silence the alert either, so it's only logged.
        try {
          const saved = await saveDecision(sellerId, trigger, msg.content);
          console.log(`${tag} decision #${saved.id} saved (${saved.actionTaken})`);
        } catch (err) {
          console.error(`${tag} could not save decision: ${err.message}`);
        }

        const decision = `*${headline(trigger)}*\n${msg.content}`;
        await postDecision(decision);
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

module.exports = { runAgent, triggerAgent, describeTrigger, toOpenAITools, createLLMClient };
