const { OpenAI } = require('openai');
const { connectAsSeller } = require('./mcpClient');
const { postDecision } = require('./notifier');
const { saveDecision, actionFromReasoning, recentFeedback } = require('../models/decisionModel');
const { checkOrderStock, describeShortfall } = require('./stockCheck');
const { getForecast } = require('./restockForecast');
const { claimRun, skippedReasoning } = require('./agentBudget');
const { enqueue, runAgainLater } = require('./jobQueue');
const { checkOrderRisk, mustHold, isFlagged, describeRisk, riskForAgent } = require('./riskCheck');

// DeepSeek speaks the OpenAI Chat Completions API, so the OpenAI SDK works
// as-is once it's pointed at their endpoint. (DEEPSEEK_BASE_URL is for tests.)
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-chat';
const MAX_STEPS = 6; // hard stop so a confused model can't loop on tool calls forever
// An order's run waits for a pending fraud analysis, checking every minute,
// for up to this long after the order was placed (orderRisk()).
const RISK_WAIT_MINUTES = 10;
const RISK_RECHECK_SECONDS = 60;

const SYSTEM_PROMPT = `You are the operations assistant for a Shopify seller.
You are triggered by store events and must decide what the seller should do.
Use your tools for context (other pending orders, low stock) - never guess stock levels.

How to read the data:
- A new order comes with a stock check for each line item (stock_left_after_order, can_ship), computed
  from Shopify's live inventory. It is final: if any line item has can_ship: false, the verdict is HOLD.
  Don't second-guess it - never assume an item (gift cards, digital goods) needs no stock.
  stock_left_after_order is what remains once this order is counted: below zero means the store sold
  more than it has. "not tracked" means the store doesn't limit that item's stock; "unknown" means the
  stock couldn't be confirmed, so a person has to check it.
- A new order also comes with Shopify's fraud check (fraud_check): risk_level is the worst of Shopify's
  and any fraud app's assessments (high, medium, low; none = not rated; pending = not finished; unknown =
  couldn't be read), recommendation is Shopify's advice (accept, investigate, cancel, none), reasons are
  the facts that raised the risk, and billing_matches_shipping says whether the billing and shipping
  addresses match (false also when one is missing; null when nothing ships).
  High risk or a cancel recommendation is final, like the stock check: the verdict is HOLD; give the
  reasons and tell the seller to review the order in Shopify before shipping. Medium risk or an
  investigate recommendation: HOLD for the seller to check, unless their notes say how they treat such
  orders. Addresses that don't match are common for gifts: on their own they're a bullet, not a HOLD.
  Pending or unknown: say in a bullet that the fraud check wasn't in yet.
- check_low_stock returns items at or below their low-stock threshold, keyed by shopify_variant_id.
  Its stock_quantity values are authoritative.
- A low-stock event can come with a restock forecast, computed from the store's orders: per_day (units
  sold a day), days_left, runs_out_on and reorder_quantity (enough to last cover_days). Use its numbers
  as given: say when each item runs out and how many to reorder, and what that's based on (based_on.days
  days, based_on.orders orders). Call a forecast with confidence "low" a rough estimate. An item with no
  sales has no run-out date - don't make one up.
- The event can be followed by the seller's ratings of your recent calls on similar events, some with a
  note. The notes say how this store works (e.g. a payment method that always shows as pending at
  first): apply them where they fit this event, and when one changes your call, say so in a bullet.
  They never override the stock check, the stock numbers or a high fraud risk.

Reply in plain text for a Slack message, under 80 words:
Line 1: one verdict followed by a short headline. The verdict is saved to the dashboard, so use exactly:
- for a new order: FULFILL if every item can ship now and the fraud check allows it, otherwise HOLD
  (mention any restock need in the bullets)
- for a low-stock event: RESTOCK
Then 2-4 bullets with the specific reasons (item names, quantities, stock numbers).`;

// The restock forecast for the items in a low-stock event (restockForecast.js),
// trimmed to what the model reads, or null when there's none to give: items
// without a variant id, or the forecast failed (the alert goes out without it).
async function lowStockForecast(sellerId, items) {
  const variantIds = items.map((i) => i.shopify_variant_id).filter(Boolean);
  if (!variantIds.length) return null;
  try {
    const forecast = await getForecast(sellerId, { variantIds });
    if (!forecast.items.length) return null;
    return {
      based_on: { days: forecast.history.days, orders: forecast.history.orders },
      cover_days: forecast.cover_days,
      items: forecast.items.map((f) => ({
        item_name: f.item_name,
        shopify_variant_id: f.shopify_variant_id,
        stock_quantity: f.stock_quantity,
        units_sold: f.units_sold,
        per_day: f.per_day,
        days_left: f.days_left,
        runs_out_on: f.runs_out_at ? f.runs_out_at.slice(0, 10) : null,
        reorder_quantity: f.reorder_quantity,
        confidence: f.confidence,
      })),
    };
  } catch (err) {
    console.warn(`[agent seller=${sellerId}] restock forecast failed: ${err.message}`);
    return null;
  }
}

// The fraud check's one line above the order's data (the details follow in fraud_check).
function riskLine(risk) {
  if (risk.error) return `Fraud check: couldn't be read (${risk.error}).`;
  if (risk.level === 'pending') return "Fraud check: Shopify's analysis hasn't finished.";
  const said = describeRisk({ ...risk, reasons: [] });
  if (mustHold(risk)) return `Fraud check: ${said} - verdict must be HOLD.`;
  if (isFlagged(risk)) return `Fraud check: ${said} - HOLD for the seller to check, unless their notes say otherwise.`;
  return `Fraud check: ${said}.`;
}

// Turns the raw trigger into the user message the model sees. Orders need
// the stock check from checkOrderStock() and can carry the fraud check from
// orderRisk(); a low-stock event can carry the forecast from lowStockForecast().
function describeTrigger(trigger, stockCheck, forecast = null, risk = null) {
  if (trigger.type === 'order_created') {
    const o = trigger.order;
    const summary = [
      stockCheck.canShip
        ? 'Stock check: every line item can ship.'
        : `Stock check: ${stockCheck.short.length} line item(s) CANNOT ship - verdict must be HOLD.`,
    ];
    if (risk) summary.push(riskLine(risk));
    const data = { order: o.name, financial_status: o.financial_status, total: o.total_price, line_items: stockCheck.lines };
    if (risk) data.fraud_check = riskForAgent(risk);
    return `A new order was just placed. Decide whether it can be fulfilled now.\n${summary.join('\n')}\n${JSON.stringify(data, null, 2)}`;
  }

  if (trigger.type === 'low_stock_crossed') {
    const event = `An inventory sync just pushed these items to or below their low-stock threshold. Decide what the seller should restock, and whether pending orders are at risk.\n${JSON.stringify(
      trigger.items,
      null,
      2
    )}`;
    if (!forecast) return event;
    return `${event}\nRestock forecast for these items, computed from the store's orders:\n${JSON.stringify(forecast, null, 2)}`;
  }

  throw new Error(`Unknown trigger type: ${trigger.type}`);
}

// The seller's ratings of earlier calls (recentFeedback()), as the text that
// follows the event, or null when there are none. Each is the call's first
// line (verdict and headline), what the seller said and their note.
function describeFeedback(rows) {
  if (!rows?.length) return null;
  const rated = rows.map((r) => ({
    decided_on: new Date(r.created_at).toISOString().slice(0, 10),
    ...(r.order_number ? { order: r.order_number } : {}),
    your_call: (r.reasoning || '').trim().split('\n')[0].slice(0, 200),
    seller_says: r.feedback === 'down' ? 'wrong call' : 'right call',
    ...(r.feedback_note ? { seller_note: r.feedback_note } : {}),
  }));
  return `The seller's ratings of your recent calls on events like this one, newest first:\n${JSON.stringify(rated, null, 2)}`;
}

// describeFeedback() for this run. A failure here shouldn't stop the run: the
// agent decides without it.
async function feedbackForAgent(sellerId, triggerType) {
  try {
    return describeFeedback(await recentFeedback(sellerId, triggerType));
  } catch (err) {
    console.warn(`[agent seller=${sellerId}] seller feedback failed: ${err.message}`);
    return null;
  }
}

// Backstop: if the model still says anything but HOLD for an order that
// can't ship, the stock data wins — the dashboard and Slack must match inventory.
function enforceStockCheck(reasoning, stockCheck) {
  if (!stockCheck || stockCheck.canShip || actionFromReasoning(reasoning) === 'hold') {
    return { reasoning, overridden: false };
  }
  const short = stockCheck.short.map(describeShortfall).join('; ');
  return {
    reasoning: `HOLD - stock check: ${short}\n(The agent's reply below disagreed; stock data wins.)\n\n${reasoning || ''}`,
    overridden: true,
  };
}

// The same backstop for fraud: high risk, or Shopify advising to cancel, is
// HOLD whatever the model says.
function enforceRiskCheck(reasoning, risk) {
  if (!mustHold(risk) || actionFromReasoning(reasoning) === 'hold') return { reasoning, overridden: false };
  return {
    reasoning: `HOLD - fraud check: ${describeRisk(risk)}\n(The agent's reply below disagreed; Shopify's fraud check wins.)\n\n${reasoning || ''}`,
    overridden: true,
  };
}

// The fraud check for an order's run. Shopify's own analysis takes seconds,
// so an order placed a moment ago often finds it pending: the job then runs
// again a minute later (not counted as a failed try, nor as an agent run),
// until RISK_WAIT_MINUTES after the order was placed. After that the agent
// decides without it and says so; the next order syncs read it again
// (riskCheck.refreshRecentRisks) and tell the seller if it came back risky.
async function orderRisk(sellerId, order) {
  const risk = await checkOrderRisk(sellerId, order.id);
  const age = Date.now() - Date.parse(order.created_at); // NaN (no wait) for jobs queued without it
  if (risk.level === 'pending' && age < RISK_WAIT_MINUTES * 60 * 1000) {
    throw runAgainLater(RISK_RECHECK_SECONDS, `Shopify's fraud analysis of order ${order.name} is still pending`);
  }
  return risk;
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
    // Not worth retrying: the job queue gives up on this one straight away.
    throw Object.assign(new Error('DEEPSEEK_API_KEY is not set in .env - skipping the LLM call'), { retryable: false });
  }
  return new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL,
    timeout: 60 * 1000, // per model call; the SDK's default of 10 minutes would hold a job slot far too long
  });
}

// The agent loop: give the model the event + the MCP tools, execute whatever
// tools it asks for, feed results back, repeat until it answers in text.
async function runAgent(sellerId, trigger) {
  const tag = `[agent seller=${sellerId} ${trigger.type}]`;
  const llm = createLLMClient(); // no key: stop here, before a run is counted
  // Before the run is counted too: while it's pending the job comes back later.
  const risk = trigger.type === 'order_created' ? await orderRisk(sellerId, trigger.order) : null;

  // Over a daily cap: no model call. The decision is still saved, so the
  // dashboard says why this event wasn't checked, but no alert goes out: a
  // busy day shouldn't become a flood of "skipped" messages.
  const limitHit = await claimRun(sellerId);
  if (limitHit) {
    const saved = await saveDecision(sellerId, trigger, skippedReasoning(limitHit, trigger));
    console.warn(`${tag} skipped: ${limitHit === 'account' ? "this account's" : 'the total'} daily agent limit is reached (decision #${saved.id})`);
    return null;
  }

  const mcp = await connectAsSeller(sellerId);
  try {
    console.log(`${tag} MCP tools: ${mcp.tools.map((t) => t.name).join(', ')}`);
    const tools = toOpenAITools(mcp.tools);
    const stockCheck = trigger.type === 'order_created' ? await checkOrderStock(sellerId, trigger.order) : null;
    const forecast = trigger.type === 'low_stock_crossed' ? await lowStockForecast(sellerId, trigger.items) : null;
    const feedback = await feedbackForAgent(sellerId, trigger.type);
    if (feedback) console.log(`${tag} with the seller's ratings of earlier calls`);
    const event = describeTrigger(trigger, stockCheck, forecast, risk);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: feedback ? `${event}\n\n${feedback}` : event },
    ];

    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await llm.chat.completions.create({ model: DEEPSEEK_MODEL, messages, tools });
      const msg = completion.choices[0].message;
      messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      if (!msg.tool_calls?.length) {
        const stockChecked = enforceStockCheck(msg.content, stockCheck);
        if (stockChecked.overridden) console.warn(`${tag} model ignored the stock check - recorded as HOLD`);
        const { reasoning, overridden } = enforceRiskCheck(stockChecked.reasoning, risk);
        if (overridden) console.warn(`${tag} model ignored the fraud check - recorded as HOLD`);

        // Save before posting, so a Slack outage can't lose the decision. A DB
        // failure shouldn't silence the alert either, so it's only logged
        // (and the alert goes without its rating buttons).
        let decisionId = null;
        try {
          const saved = await saveDecision(sellerId, trigger, reasoning);
          decisionId = saved.id;
          console.log(`${tag} decision #${saved.id} saved (${saved.actionTaken})`);
        } catch (err) {
          console.error(`${tag} could not save decision: ${err.message}`);
        }

        const decision = `*${headline(trigger)}*\n${reasoning}`;
        await postDecision(sellerId, decision, { decisionId });
        return decision;
      }

      for (const call of msg.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // Model sent malformed JSON args: call with none, so the tool uses its defaults.
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

// Only what the agent reads from an order, so no customer name, address or
// email sits in the job queue. created_at is how long a run waits for the
// fraud check (orderRisk()).
function slimTrigger(trigger) {
  if (trigger.type !== 'order_created') return trigger;
  const o = trigger.order;
  return {
    type: 'order_created',
    order: {
      id: o.id,
      name: o.name,
      ...(o.created_at ? { created_at: o.created_at } : {}),
      financial_status: o.financial_status,
      total_price: o.total_price,
      line_items: (o.line_items || []).map((li) => ({
        variant_id: li.variant_id ?? null,
        title: li.title,
        variant_title: li.variant_title ?? null,
        quantity: li.quantity,
      })),
    },
  };
}

// Puts an agent run on the job queue (runs in the background worker, see
// jobHandlers.js). It's saved before the webhook or sync that caused it
// returns, retried if the model or network fails, and survives a restart.
// One run per order, however many times Shopify delivers it; resolves to the
// job id, or null for an order that already has one.
function queueAgentRun(sellerId, trigger) {
  const dedupeKey = trigger.type === 'order_created' ? `agent:order:${sellerId}:${trigger.order.id}` : null;
  return enqueue('agent_run', sellerId, { trigger: slimTrigger(trigger) }, { dedupeKey });
}

module.exports = {
  runAgent,
  queueAgentRun,
  slimTrigger,
  describeTrigger,
  describeFeedback,
  enforceStockCheck,
  enforceRiskCheck,
  toOpenAITools,
  createLLMClient,
};
