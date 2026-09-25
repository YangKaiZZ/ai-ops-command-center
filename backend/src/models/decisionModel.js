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

const NOTE_MAX_LENGTH = 500; // the feedback_note column

// Verdicts the seller can rate. A skipped run never reached the agent, so
// there's no call to judge.
const RATED_ACTIONS = ['fulfill', 'hold', 'low_stock_alert', 'unknown'];

// Thumbs up and down so far, from rows of { action_taken, n, up, down }
// (decisions grouped by verdict): { up, down, unrated, by_verdict }, with
// the same three counts for each verdict. Skipped runs aren't counted.
function countRatings(rows) {
  const byVerdict = Object.fromEntries(RATED_ACTIONS.map((action) => [action, { up: 0, down: 0, unrated: 0 }]));
  for (const row of rows) {
    if (row.action_taken === 'skipped') continue;
    const counts = byVerdict[RATED_ACTIONS.includes(row.action_taken) ? row.action_taken : 'unknown'];
    const up = Number(row.up) || 0;
    const down = Number(row.down) || 0;
    counts.up += up;
    counts.down += down;
    counts.unrated += Number(row.n) - up - down;
  }
  const total = (key) => Object.values(byVerdict).reduce((sum, counts) => sum + counts[key], 0);
  return { up: total('up'), down: total('down'), unrated: total('unrated'), by_verdict: byVerdict };
}

// The SQL behind countRatings: decisions with how many were rated up and down.
// Callers add the WHERE (seller, dates) and GROUP BY action_taken.
const RATINGS_SELECT = `SELECT action_taken, COUNT(*) AS n, SUM(feedback = 'up') AS up, SUM(feedback = 'down') AS down FROM decisions`;

// The seller's thumbs up or down on one of their decisions, with an optional
// note; feedback null clears both. Returns the saved { id, feedback,
// feedback_note, feedback_at }, 'not_found' when the decision isn't the
// seller's, or 'skipped' for a skipped run (nothing to rate).
async function setFeedback(sellerId, decisionId, { feedback, note }) {
  const [[decision]] = await pool.query('SELECT action_taken FROM decisions WHERE id = ? AND seller_id = ?', [decisionId, sellerId]);
  if (!decision) return 'not_found';
  if (decision.action_taken === 'skipped') return 'skipped';
  await pool.query(
    `UPDATE decisions SET feedback = ?, feedback_note = ?, feedback_at = IF(? IS NULL, NULL, CURRENT_TIMESTAMP)
     WHERE id = ? AND seller_id = ?`,
    [feedback, feedback ? note : null, feedback, decisionId, sellerId]
  );
  const [[saved]] = await pool.query('SELECT id, feedback, feedback_note, feedback_at FROM decisions WHERE id = ?', [decisionId]);
  return saved;
}

// How much of the seller's feedback the agent reads before a run.
const AGENT_FEEDBACK = { limit: 8, days: 90 };

// The seller's recent ratings for the agent to learn from, on one kind of
// event: orders ('order_created', decisions with an order number) or low
// stock (the rest). Every call marked wrong, plus calls marked right that
// came with a note; newest rating first.
async function recentFeedback(sellerId, triggerType, { limit = AGENT_FEEDBACK.limit, days = AGENT_FEEDBACK.days } = {}) {
  const kind = triggerType === 'order_created' ? 'order_number IS NOT NULL' : 'order_number IS NULL';
  const [rows] = await pool.query(
    `SELECT order_number, action_taken, reasoning, feedback, feedback_note, created_at FROM decisions
     WHERE seller_id = ? AND ${kind}
       AND (feedback = 'down' OR (feedback = 'up' AND feedback_note IS NOT NULL))
       AND feedback_at >= NOW() - INTERVAL ? DAY
     ORDER BY feedback_at DESC, id DESC
     LIMIT ?`,
    [sellerId, days, limit]
  );
  return rows;
}

// A decision, if it belongs to the account linked to this Telegram chat
// (for rating it from the chat): { seller_id, action_taken, feedback, feedback_note }, or null.
async function decisionForTelegramChat(decisionId, chatId) {
  const [[row]] = await pool.query(
    `SELECT d.seller_id, d.action_taken, d.feedback, d.feedback_note FROM decisions d
     JOIN sellers s ON s.id = d.seller_id
     WHERE d.id = ? AND s.telegram_chat_id = ?`,
    [decisionId, String(chatId)]
  );
  return row || null;
}

// What a rating link or button shows about a decision: its order, verdict,
// first line and current rating, not the full reasoning.
async function decisionSummary(sellerId, decisionId) {
  const [[row]] = await pool.query(
    `SELECT id, order_number, action_taken, reasoning, created_at, feedback, feedback_note FROM decisions
     WHERE id = ? AND seller_id = ?`,
    [decisionId, sellerId]
  );
  if (!row) return null;
  const { reasoning, ...rest } = row;
  return { ...rest, headline: (reasoning || '').trim().split('\n')[0].slice(0, 300) };
}

module.exports = {
  saveDecision,
  actionFromReasoning,
  countRatings,
  setFeedback,
  recentFeedback,
  decisionForTelegramChat,
  decisionSummary,
  RATINGS_SELECT,
  AGENT_FEEDBACK,
  NOTE_MAX_LENGTH,
};
