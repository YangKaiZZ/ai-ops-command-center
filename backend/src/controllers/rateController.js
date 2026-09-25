const pool = require('../config/db');
const { verifyRatingToken } = require('../services/ratingLinks');
const { decisionSummary, setFeedback } = require('../models/decisionModel');
const { parseFeedback } = require('./decisionsController');

// The rating page behind the buttons in alerts (ratingLinks.js). No sign-in:
// the signed token names the one decision it can rate.

const LINK_ERRORS = {
  invalid: [404, "This rating link isn't valid."],
  expired: [410, 'This rating link has expired. Rate the decision on the Decisions page instead.'],
};

// The decision a token names, or sends the error and returns null.
async function decisionFor(req, res) {
  const verified = verifyRatingToken(req.params.token);
  if (verified.error) {
    const [status, error] = LINK_ERRORS[verified.error];
    res.status(status).json({ error });
    return null;
  }
  const decision = await decisionSummary(verified.sellerId, verified.decisionId);
  if (!decision || decision.action_taken === 'skipped') {
    res.status(404).json({ error: 'That decision is no longer there.' });
    return null;
  }
  return { ...verified, decision };
}

// GET /api/rate/:token
// What the page shows: the decision's order, verdict, first line and rating.
async function getRating(req, res) {
  try {
    const found = await decisionFor(req, res);
    if (!found) return;
    const [[seller]] = await pool.query('SELECT business_name FROM sellers WHERE id = ?', [found.sellerId]);
    res.json({ decision: found.decision, business_name: seller?.business_name ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the decision' });
  }
}

// PUT /api/rate/:token   Body: { feedback: "up" | "down" | null, note? } as on the dashboard.
async function putRating(req, res) {
  const parsed = parseFeedback(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const found = await decisionFor(req, res);
    if (!found) return;
    res.json(await setFeedback(found.sellerId, found.decisionId, parsed));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the rating' });
  }
}

module.exports = { getRating, putRating };
