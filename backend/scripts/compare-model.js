// Re-runs the agent on stored orders with the configured model and prints its
// answer next to the decision already saved for that order. Read-only: nothing
// is saved, no alert is sent, no hold is placed. It MAKES REAL MODEL CALLS
// (1-3 per order, more if the model keeps asking for tools) and so costs money.
//
// Usage:  node scripts/compare-model.js <sellerId> <orderNumber> [<orderNumber> ...]
//   e.g.  node scripts/compare-model.js 1 "#1001" "#1002"
const path = require('path');
process.chdir(path.join(__dirname, '..'));
require('dotenv').config();

const pool = require('../src/config/db');
const aiModel = require('../src/services/aiModel');
const { connectAsSeller } = require('../src/services/mcpClient');
const { checkOrderStock } = require('../src/services/stockCheck');
const { checkOrderRisk } = require('../src/services/riskCheck');
const agent = require('../src/services/agentService');

async function main() {
  const [sellerArg, ...numbers] = process.argv.slice(2);
  const sellerId = Number(sellerArg);
  if (!sellerId || !numbers.length) throw new Error('Usage: node scripts/compare-model.js <sellerId> <orderNumber> [...]');

  // Not the older DEEPSEEK_API_KEY: this check is about the new model.
  if (!(process.env.AI_API_KEY || '').trim()) throw new Error('Set AI_API_KEY in backend/.env first');
  const settings = aiModel.modelSettings();
  console.log(`Model: ${settings.name} ${settings.model} (reasoning effort: ${settings.reasoningEffort || 'n/a'})\n`);

  const llm = agent.createLLMClient();
  const totals = { calls: 0, prompt: 0, completion: 0, reasoning: 0 };

  for (const number of numbers) {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE seller_id = ? AND order_number = ?', [sellerId, number]);
    if (!order) throw new Error(`Seller ${sellerId} has no order ${number}`);
    const [items] = await pool.query('SELECT * FROM order_line_items WHERE order_id = ?', [order.id]);
    const [[saved]] = await pool.query('SELECT reasoning, action_taken FROM decisions WHERE order_id = ? ORDER BY id DESC LIMIT 1', [order.id]);

    // The same trigger a webhook would queue (see slimTrigger).
    const trigger = {
      type: 'order_created',
      order: {
        id: order.shopify_order_id,
        name: order.order_number,
        financial_status: order.financial_status,
        total_price: order.total_amount,
        line_items: items.map((li) => ({
          variant_id: li.shopify_variant_id,
          title: li.title,
          variant_title: li.variant_title,
          quantity: li.quantity,
        })),
      },
    };
    const stockCheck = await checkOrderStock(sellerId, trigger.order);
    const risk = await checkOrderRisk(sellerId, trigger.order.id);
    const event = agent.describeTrigger(trigger, stockCheck, null, risk);

    const mcp = await connectAsSeller(sellerId);
    let reply = '';
    let toolCalls = 0;
    try {
      const tools = agent.toOpenAITools(mcp.tools);
      const messages = [
        { role: 'system', content: agent.SYSTEM_PROMPT },
        { role: 'user', content: event },
      ];
      for (let step = 0; step < agent.MAX_STEPS; step++) {
        const completion = await llm.chat.completions.create({ ...aiModel.completionOptions(), messages, tools });
        const u = completion.usage || {};
        totals.calls++;
        totals.prompt += u.prompt_tokens || 0;
        totals.completion += u.completion_tokens || 0;
        totals.reasoning += u.completion_tokens_details?.reasoning_tokens || 0;
        const msg = completion.choices[0].message;
        messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
        if (!msg.tool_calls?.length) {
          reply = msg.content || '';
          break;
        }
        for (const call of msg.tool_calls) {
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || '{}');
          } catch {
            // malformed args: call with none, as the agent does
          }
          toolCalls++;
          const result = await mcp.callTool(call.function.name, args);
          messages.push({ role: 'tool', tool_call_id: call.id, content: result.isError ? `ERROR: ${result.text}` : result.text });
        }
      }
    } finally {
      await mcp.close();
    }

    const stock = agent.enforceStockCheck(reply, stockCheck);
    const final = agent.enforceRiskCheck(stock.reasoning, risk);
    console.log(`===== ${number} =====`);
    console.log(`Stock check: ${stockCheck.canShip ? 'can ship' : 'CANNOT ship'}; fraud check: ${risk.level}; tool calls by the model: ${toolCalls}`);
    console.log(`\n--- saved decision (${saved ? saved.action_taken : 'none'}) ---\n${saved ? saved.reasoning : '(none saved)'}`);
    console.log(`\n--- ${settings.model} ---\n${final.reasoning}`);
    if (stock.overridden || final.overridden) console.log('\n(The code overrode the model here: it ignored the stock or fraud check.)');
    console.log();
  }

  console.log(`Usage: ${totals.calls} model calls, ${totals.prompt} prompt tokens, ${totals.completion} completion tokens (${totals.reasoning} of them hidden reasoning)`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
