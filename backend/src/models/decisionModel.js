const pool = require('../config/db');

// The agent's reply starts with a verdict (see SYSTEM_PROMPT in agentService).
// It only *recommends* today, so these name the recommendation, not an action.
// SKIPPED isn't the model's: it's saved when a daily limit stopped the run (agentBudget).
const VERDICT_TO_ACTION = {
  FULFILL: 'fulfill',
  HOLD: 'hold',
  RESTOCK: 'low_stock_alert',
  SKIPPED: 'skipped',
};

function actionFromReasoning(reasoning) {
  const firstLine = (reasoning || '').trim().split('\n')[0];
  const match = firstLine.match(/\b(FULFILL|HOLD|RESTOCK|SKIPPED)\b/);
  return match ? VERDICT_TO_ACTION[match[1]] : 'unknown';
}

// Saves one agent decision. Order-triggered decisions are linked to our
// orders row (the webhook stores the order before the agent runs).
async function saveDecision(sellerId, trigger, reasoning) {
  let orderId = null;
  let orderNumber = null;

  if (trigger.type === 'order_created') {
    orderNumber = trigger.order.name;
    const [rows] = await pool.query('SELECT id FROM orders WHERE seller_id = ? AND shopify_order_id = ?', [
      sellerId,
      String(trigger.order.id),
    ]);
    orderId = rows[0]?.id ?? null;
  }

  const actionTaken = actionFromReasoning(reasoning);
  const [result] = await pool.query(
    'INSERT INTO decisions (seller_id, order_id, order_number, reasoning, action_taken) VALUES (?, ?, ?, ?, ?)',
    [sellerId, orderId, orderNumber, reasoning || '', actionTaken]
  );
  return { id: result.insertId, actionTaken };
}

module.exports = { saveDecision, actionFromReasoning };
