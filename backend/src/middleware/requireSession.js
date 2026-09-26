// Account settings (Slack, API keys) and acting on orders in Shopify (hold,
// fulfill) need a signed-in seller. An API key only reads and syncs store
// data, so a leaked key can't mint more keys, redirect alerts or ship orders.
// Runs after requireAuth.
function requireSession(req, res, next) {
  if (req.authMethod !== 'session') {
    return res.status(403).json({ error: 'Sign in to the dashboard to do this: API keys can only read and sync store data' });
  }
  next();
}

module.exports = requireSession;
