// Refuses what a "Try the demo" account (services/demo.js) mustn't do: things
// that reach outside the app (connecting a real store, alert channels,
// messages, API keys). Runs after requireAuth.
function notInDemo(req, res, next) {
  if (req.isDemo) {
    return res.status(403).json({ error: "That's turned off in the demo, which has no real store or alert channels. Sign up to use it." });
  }
  next();
}

module.exports = notInDemo;
