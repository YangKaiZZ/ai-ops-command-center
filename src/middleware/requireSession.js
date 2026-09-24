// Account settings (Slack, API keys) need a signed-in seller. An API key
// only reads and syncs store data, so a leaked key can't mint more keys or
// redirect alerts. Runs after requireAuth.
function requireSession(req, res, next) {
  if (req.authMethod !== 'session') {
    return res.status(403).json({ error: 'Sign in to the dashboard to change settings (API keys can\'t)' });
  }
  next();
}

module.exports = requireSession;
