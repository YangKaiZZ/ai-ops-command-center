const app = require('./app');
const { startScheduledSync } = require('./services/scheduler');
const { startTelegramPolling } = require('./services/telegram');

if (process.env.SLACK_WEBHOOK_URL) {
  console.warn('[config] SLACK_WEBHOOK_URL in .env is no longer used: each seller sets their own Slack webhook in Settings.');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Ops backend running on port ${PORT}`);
  startScheduledSync();
  startTelegramPolling();
});
