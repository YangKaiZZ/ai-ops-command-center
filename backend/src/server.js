const app = require('./app');
const { startScheduledSync } = require('./services/scheduler');
const { startTelegramPolling } = require('./services/telegram');
const { startWorker, stopWorker } = require('./services/jobQueue');
require('./services/jobHandlers'); // what each job type does

if (process.env.SLACK_WEBHOOK_URL) {
  console.warn('[config] SLACK_WEBHOOK_URL in .env is no longer used: each seller sets their own Slack webhook in Settings.');
}

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`AI Ops backend running on port ${PORT}`);
  startScheduledSync();
  startTelegramPolling();
  startWorker().catch((err) => console.error(`[jobs] worker failed to start: ${err.message}`));
});

// On a restart (docker compose stop, Ctrl+C): stop taking requests and jobs,
// give running jobs a moment to finish, then exit. A job cut off here is
// queued again when the backend starts.
async function shutdown(signal) {
  console.log(`[server] ${signal}: finishing running jobs before exiting`);
  server.close();
  const finished = await stopWorker(25 * 1000);
  if (!finished) console.warn('[server] some jobs were still running; they run again after the restart');
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
