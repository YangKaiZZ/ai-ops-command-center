const pool = require('../config/db');
const { countRatings, setFeedback, RATINGS_SELECT } = require('../models/decisionModel');

const FEEDBACK_VALUES = ['up', 'down'];
const MAX_NOTE_LENGTH = 500;

// GET /api/decisions?limit=50
// The agent's recent decisions for this seller, newest first — the dashboard
// feed — with the seller's ratings over every decision so far.
async function getDecisions(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const [rows] = await pool.query(
      `SELECT id, order_id, order_number, action_taken, reasoning, created_at, feedback, feedback_note, feedback_at
       FROM decisions
       WHERE seller_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [req.sellerId, limit]
    );
    const [ratingRows] = await pool.query(`${RATINGS_SELECT} WHERE seller_id = ? GROUP BY action_taken`, [req.sellerId]);
    res.json({ decisions: rows, ratings: countRatings(ratingRows) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not fetch decisions' });
  }
}

// The body of PUT /api/decisions/:id/feedback: { feedback: "up" | "down" |
// null, note?: text }. Returns { feedback, note } or { error }. A blank note
// is no note, and clearing the rating (null) drops the note too.
function parseFeedback(body) {
  const { feedback, note = null } = body || {};
  if (feedback !== null && !FEEDBACK_VALUES.includes(feedback)) return { error: 'feedback must be "up", "down" or null' };
  if (note !== null && typeof note !== 'string') return { error: 'note must be text' };
  const text = note?.trim() || null;
  if (text && text.length > MAX_NOTE_LENGTH) return { error: `note can be at most ${MAX_NOTE_LENGTH} characters` };
  return { feedback, note: feedback ? text : null };
}

// PUT /api/decisions/:id/feedback
// The seller says whether the agent got it right (thumbs up or down).
async function putFeedback(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Decision not found' });
  const parsed = parseFeedback(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const saved = await setFeedback(req.sellerId, id, parsed);
    if (saved === 'not_found') return res.status(404).json({ error: 'Decision not found' });
    if (saved === 'skipped') return res.status(400).json({ error: 'A skipped run has no verdict to rate' });
    res.json(saved);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the feedback' });
  }
}

module.exports = { getDecisions, putFeedback, parseFeedback };
