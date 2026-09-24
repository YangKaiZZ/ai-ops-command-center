const axios = require('axios');
const { getSlackWebhookUrl } = require('../models/sellerModel');

// Only Slack's own webhook host is allowed. The backend POSTs to this URL, so
// accepting any URL would let a seller make the server call internal addresses.
function isSlackWebhookUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com' && url.pathname.length > 1;
  } catch {
    return false;
  }
}

// Posts the agent's decision somewhere this seller will see it: their own
// Slack channel if they've set one in Settings, otherwise the server console.
// (It's always saved to the dashboard's decisions log first.)
async function postDecision(sellerId, text) {
  let url = null;
  try {
    url = await getSlackWebhookUrl(sellerId);
  } catch (err) {
    console.error(`[notifier] seller ${sellerId}: could not read Slack settings: ${err.message}`);
  }
  if (!url) {
    console.log(`\n[agent decision seller=${sellerId}]\n${text}\n`);
    return;
  }

  try {
    await axios.post(url, { text }, { timeout: 5000, maxRedirects: 0 });
    console.log(`[notifier] seller ${sellerId}: posted to Slack: ${text.split('\n')[0]}`);
  } catch (err) {
    // Don't lose the decision just because Slack is down or the URL is wrong.
    console.error(`[notifier] seller ${sellerId}: Slack post failed:`, err.response?.status || err.message);
    console.log(`\n[agent decision seller=${sellerId}]\n${text}\n`);
  }
}

module.exports = { postDecision, isSlackWebhookUrl };
