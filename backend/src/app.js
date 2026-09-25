// The Express app: routes and middleware, no listening. server.js starts it;
// tests can mount it on any port.
const express = require('express');
require('dotenv').config({ quiet: true });

const authRoutes = require('./routes/authRoutes');
const ordersRoutes = require('./routes/ordersRoutes');
const storeRoutes = require('./routes/storeRoutes');
const inventoryRoutes = require('./routes/inventoryRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const decisionsRoutes = require('./routes/decisionsRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const shopifyRoutes = require('./routes/shopifyRoutes');
const overviewRoutes = require('./routes/overviewRoutes');

const app = express();
// Behind a reverse proxy (Caddy, in deploy/) every request arrives from the
// proxy; TRUST_PROXY=1 takes the visitor's address from the X-Forwarded-For
// header the proxy adds, for the sign-in limits. Leave it unset when nothing
// sits in front, or anyone could claim any address.
const trustedProxies = Number(process.env.TRUST_PROXY);
if (trustedProxies > 0) app.set('trust proxy', trustedProxies);

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
app.use('/api/shopify', shopifyRoutes);
app.use('/api/overview', overviewRoutes);

module.exports = app;
