const axios = require('axios');

// Posts the agent's decision somewhere a human will see it: Slack if an
// incoming-webhook URL is configured, otherwise the server console.
async function postDecision(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.log(`\n[agent decision]\n${text}\n`);
    return;
  }

  try {
    await axios.post(url, { text });
    console.log(`[notifier] posted to Slack: ${text.split('\n')[0]}`);
  } catch (err) {
    // Don't lose the decision just because Slack is down or the URL is wrong.
    console.error('[notifier] Slack post failed:', err.response?.status || err.message);
    console.log(`\n[agent decision]\n${text}\n`);
  }
}

module.exports = { postDecision };
