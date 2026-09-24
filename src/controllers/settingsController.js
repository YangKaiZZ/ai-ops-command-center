const { getSettings: loadSettings, setSlackWebhookUrl } = require('../models/sellerModel');
const { isSlackWebhookUrl } = require('../services/notifier');
const { createApiKey, listApiKeys, revokeApiKey } = require('../models/apiKeyModel');

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

// GET /api/settings/api-keys
// Active keys: name, first characters, created, last used. Never the key itself.
async function listKeys(req, res) {
  try {
    res.json({ api_keys: await listApiKeys(req.sellerId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load API keys' });
  }
}

// POST /api/settings/api-keys
// Body: { name } - e.g. "Claude Desktop". The response is the only time the full key is shown.
async function createKey(req, res) {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 100) {
    return res.status(400).json({ error: 'Give the key a name (up to 100 characters), e.g. "Claude Desktop"' });
  }
  try {
    const result = await createApiKey(req.sellerId, name);
    if (result.error) return res.status(409).json({ error: result.error });
    res.status(201).json({ key: result.key, api_key: result.apiKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create the API key' });
  }
}

// DELETE /api/settings/api-keys/:id
// Revoked keys stop working immediately.
async function revokeKey(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid key id' });
  try {
    if (!(await revokeApiKey(req.sellerId, id))) return res.status(404).json({ error: 'API key not found' });
    res.json({ revoked: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not revoke the API key' });
  }
}

module.exports = { getSettings, setSlack, clearSlack, listKeys, createKey, revokeKey };
