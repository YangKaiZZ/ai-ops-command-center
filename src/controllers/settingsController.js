const { getSettings: loadSettings, setSlackWebhookUrl } = require('../models/sellerModel');
const { isSlackWebhookUrl } = require('../services/notifier');

// GET /api/settings
// Account, store and notification status for the settings page. Never returns secrets.
async function getSettings(req, res) {
  try {
    const settings = await loadSettings(req.sellerId);
    if (!settings) return res.status(404).json({ error: 'Account not found' });
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load settings' });
  }
}

// PUT /api/settings/slack
// Body: { webhook_url } - a Slack incoming-webhook URL. Agent decisions for
// this seller are posted there.
async function setSlack(req, res) {
  const url = typeof req.body?.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
  if (!isSlackWebhookUrl(url)) {
    return res.status(400).json({ error: 'Enter a Slack incoming-webhook URL (it starts with https://hooks.slack.com/)' });
  }
  try {
    await setSlackWebhookUrl(req.sellerId, url);
    res.json({ slack: { connected: true } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the Slack webhook' });
  }
}

// DELETE /api/settings/slack
async function clearSlack(req, res) {
  try {
    await setSlackWebhookUrl(req.sellerId, null);
    res.json({ slack: { connected: false } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove the Slack webhook' });
  }
}

module.exports = { getSettings, setSlack, clearSlack };
