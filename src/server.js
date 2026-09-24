const express = require('express');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const ordersRoutes = require('./routes/ordersRoutes');
const storeRoutes = require('./routes/storeRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const decisionsRoutes = require('./routes/decisionsRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const { startScheduledSync } = require('./services/scheduler');

const app = express();
// Webhooks go before express.json(): HMAC verification needs the raw body,
// and once the JSON parser has consumed the stream it's gone.
app.use('/api/webhooks', webhookRoutes);
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/store', storeRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/decisions', decisionsRoutes);
app.use('/api/settings', settingsRoutes);

if (process.env.SLACK_WEBHOOK_URL) {
  console.warn('[config] SLACK_WEBHOOK_URL in .env is no longer used: each seller sets their own Slack webhook in Settings.');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Ops backend running on port ${PORT}`);
  startScheduledSync();
});
