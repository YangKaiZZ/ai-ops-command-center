# AI Ops Command Center — Backend (Phase 1)

RESTful API + auth + multi-tenant DB schema. This is the foundation the MCP
tool layer and Claude agent get built on top of in later phases.

## What's here
- `schema.sql` — multi-tenant MySQL schema (sellers, orders, inventory, messages)
- `src/config/db.js` — MySQL connection pool
- `src/controllers/authController.js` — register/login, JWT issuing
- `src/controllers/ordersController.js` — order queries, scoped per seller
- `src/middleware/auth.js` — protects routes, attaches `req.sellerId`
- `src/routes/` — endpoint definitions
- `src/server.js` — app entrypoint

## Run it locally
1. Install MySQL if you don't have it (or use XAMPP, which you may already have).
2. Create the database and tables:
   ```
   mysql -u root -p < schema.sql
   ```
3. Copy `.env.example` to `.env` and fill in your DB password, plus a random
   `JWT_SECRET` and `ENCRYPTION_KEY` (the server refuses to start without them).
   Generate each with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Shopify access tokens are encrypted with `ENCRYPTION_KEY` before they're
   stored. Keep the key safe: without it, stored tokens can't be read.

   **Upgrading an existing database?** Run `npm run migrate`. It adds any
   new columns/tables and encrypts tokens that were stored in plain text.
   It's safe to run more than once.
4. Install deps and run:
   ```
   npm install
   npm run dev
   ```
5. Test it:
   ```
   curl http://localhost:3000/health

   curl -X POST http://localhost:3000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"business_name":"Test Store","email":"test@test.com","password":"password123"}'

   # copy the token from the response, then:
   curl http://localhost:3000/api/orders \
     -H "Authorization: Bearer PASTE_TOKEN_HERE"
   ```

## Docker
The `Dockerfile` builds this API with the MCP server inside (the agent starts
it as a subprocess), so it takes the [ai-ops-mcp](../../ai-ops-mcp) folder as a
second build context:

```
docker build --build-context mcp=../../ai-ops-mcp -t ai-ops-backend .
```

The container runs `npm run migrate` before starting, and takes its settings
from environment variables (no `.env` inside the image). To run the whole app
on a server, use the [ai-ops-deploy](../../ai-ops-deploy) folder's Docker
Compose setup and its README.

## Connecting a store
Sellers connect from the dashboard's Settings page, one of two ways.

**Connect with Shopify** (OAuth). The seller types their store address,
approves the app on Shopify and lands back on Settings. The backend then
registers the webhooks and imports orders and products in the background.
It needs these in `.env`:
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`: client ID and secret of your app in the Shopify Dev Dashboard
- `APP_URL`: this backend's public https URL (an ngrok tunnel while developing)
- `DASHBOARD_URL`: where the dashboard runs (default `http://localhost:3005`)
- `SHOPIFY_SCOPES` (optional): default `read_orders,read_products,read_inventory`

and, in the app's configuration on Shopify:
- **App URL**: `<APP_URL>/api/shopify/install`. A merchant who installs from Shopify's side lands
  here: a store we know goes straight to approval, a new one is sent to sign up first.
- **Allowed redirection URL**: `<APP_URL>/api/shopify/callback`
- **Compliance webhooks**: see "Privacy webhooks" below.

Connections use Shopify's expiring offline tokens (1 hour, with a refresh
token). They're refreshed automatically, one refresh at a time per seller
(each refresh invalidates the previous refresh token). If Shopify rejects a
refresh, the store shows as disconnected and needs reconnecting.

**Paste a token**, for a custom app made in the store's own admin
(Settings > Apps > Develop apps): `POST /api/store/connect` with
`{ "shop_domain": "...", "access_token": "shpat_..." }`. The token is
checked with Shopify before it's saved. These tokens don't expire.

Either way:
- One account per store. Connecting an account to a *different* store clears the old store's
  orders and stock (decisions stay as history).
- `DELETE /api/store` disconnects: it uninstalls the app from the store and forgets the token.
  Uninstalling from Shopify's side (`app/uninstalled`) does the same.
- Changing the store connection needs a signed-in session; API keys can't.

Endpoints: `POST /api/shopify/connect` `{ "shop": "my-store" }` returns `{ authorize_url }`;
`GET /api/shopify/install` and `GET /api/shopify/callback` are Shopify's redirects,
checked with Shopify's HMAC signature, the one-time `state` and a timestamp.

`npm run test:onboarding` runs all of this in-process against a fake Shopify.

### Privacy webhooks
Apps on the Shopify App Store must handle three privacy (GDPR) webhooks. In
the app's configuration, set the **compliance webhooks** URL to
`<APP_URL>/api/webhooks/compliance`; all three arrive there:

| Topic | What happens |
| --- | --- |
| `customers/data_request` | logged; `GET /api/settings/privacy-requests` lists each request with the data we hold for those orders, for the seller to pass on |
| `customers/redact` | the buyer's name on those orders becomes "Redacted", and is scrubbed from decision text |
| `shop/redact` | (48 h after uninstall) deletes the store's orders, stock, decisions and messages; skipped if the store was connected again. The seller's login stays |

Each request is logged in `privacy_requests` with ids and outcomes only,
never the personal data. Unsigned requests get 401, as Shopify's review expects.

## Phase 4: event-triggered agent
Two triggers run the same agent loop (`src/services/agentService.js`):
1. **New order** — Shopify calls `POST /api/webhooks/orders-create`. The HMAC
   signature is verified against `SHOPIFY_WEBHOOK_SECRET`, the order is stored,
   and the agent decides if it's fulfillable.
2. **Low stock** — any tracked item that goes from above its threshold to
   at/below it triggers the agent, whether the drop arrives by an
   `inventory_levels/update` webhook, a scheduled sync or `POST /api/inventory/sync`.

The agent calls DeepSeek (`deepseek-chat`, via the OpenAI SDK) and gets the
Phase 3 MCP server's read-only tools — the backend spawns that server with a
10-minute JWT for the seller in question. The decision goes to that seller's
own Slack channel, or to the server console if they haven't set one.

Each seller sets their Slack incoming-webhook URL through the settings API
(the dashboard's Settings page). It's stored encrypted, and only
`https://hooks.slack.com/...` URLs are accepted:
- `GET /api/settings` - account, store and Slack status (never the secrets themselves)
- `PUT /api/settings/slack` with `{ "webhook_url": "https://hooks.slack.com/services/..." }`
- `DELETE /api/settings/slack`

The old global `SLACK_WEBHOOK_URL` in `.env` is ignored: it sent every
seller's orders to one channel.

**Email and Telegram alerts** work the same way, per seller, next to Slack.
Each decision goes to every channel the seller turned on; one failing
channel doesn't stop the others.
- Email (needs `SMTP_URL` + `EMAIL_FROM`): `PUT /api/settings/email` `{ "email" }`
  sends a 6-digit code; `POST /api/settings/email/verify` `{ "code" }` turns it on;
  `DELETE /api/settings/email`. Alerts only go to a confirmed address. At most 5
  codes an hour and 5 tries per code.
- Telegram (needs `TELEGRAM_BOT_TOKEN`): `POST /api/settings/telegram` returns a
  one-time `https://t.me/<bot>?start=<code>` link (15 min). Pressing Start links
  that chat; `/stop` in the chat or `DELETE /api/settings/telegram` unlinks it.
  The backend long-polls the bot, so it works without a public URL, but only
  one backend process may poll a bot at a time.
- `GET /api/settings` shows each as `email_alerts: { available, address, pending }` and
  `telegram: { available, connected }`.
- `POST /api/settings/test-alert` sends a sample to every channel that's on and
  reports how each went.

WhatsApp isn't offered: sending business messages needs a verified Meta
business account and approved message templates.

`npm run test:alerts` checks email and Telegram against a fake mail server
and a fake Telegram on localhost.

**API keys** let tools like the MCP server in Claude Desktop read a
seller's data without a sign-in token that expires in 7 days. Keys look
like `aiops_...`, are sent as `Authorization: Bearer <key>` on the same
endpoints, and only their SHA-256 hash is stored:
- `GET /api/settings/api-keys` - active keys (name, first characters, created, last used)
- `POST /api/settings/api-keys` with `{ "name": "Claude Desktop" }` - the response is the only time the key is shown
- `DELETE /api/settings/api-keys/:id` - revoke; it stops working immediately

Everything under `/api/settings` needs a signed-in session: an API key can
read and sync store data, but can't change Slack or create more keys.

Settings in `.env`: `SHOPIFY_WEBHOOK_SECRET`, `DEEPSEEK_API_KEY`,
`MCP_SERVER_PATH` (see `.env.example`).

**Stock check.** Whether each line item can ship is decided in code
(`src/services/stockCheck.js`) from Shopify's *live* stock, not our last
sync. Shopify takes an order's units off "available" as soon as the order is
created, so the live number is what's left after this order; below zero means
the store oversold. A variant that no longer exists holds the order. If Shopify
can't be reached, the last sync is used, read strictly.

**Syncing.** Order and product syncs follow Shopify's pagination to the last
page (250 per request, retrying on rate limits), so big stores are complete.
A product sync also removes rows for variants that were deleted or stopped
being tracked.

Test the full flow with a signed fake order (backend running; with
`DEEPSEEK_API_KEY` set, this makes one real LLM call):
```
npm run test:agent
```

Stores connected with "Connect with Shopify" or a pasted token get their
webhooks registered automatically at `APP_URL`. To move them to a new
tunnel URL (or set them up for a store connected before this existed),
expose the backend publicly (e.g. `ngrok http 3000`) and run:
```
node scripts/register-webhooks.js https://<tunnel>.ngrok-free.app --dry-run   # see what would change
node scripts/register-webhooks.js https://<tunnel>.ngrok-free.app
```
It registers (or moves to the new tunnel) all four topics:

| Topic | Route | What it does |
| --- | --- | --- |
| `orders/create` | `/api/webhooks/orders-create` | stores the order, runs the agent |
| `orders/updated` | `/api/webhooks/orders-updated` | keeps shipping/payment status current |
| `inventory_levels/update` | `/api/webhooks/inventory-levels-update` | re-reads that variant's stock; an item that just went low triggers the agent |
| `app/uninstalled` | `/api/webhooks/app-uninstalled` | disconnects the store (the shop domain is kept for the privacy webhooks) |

`inventory_levels/update` needs the app's token to have the `read_inventory` scope.
Run the script again whenever the tunnel URL changes.

**Scheduled sync.** In case a webhook is missed, every connected store is
re-synced every `SYNC_INTERVAL_MINUTES` (default 15, `0` = off). Orders
sync incrementally (only what changed since the last sync), products in full.
Manual syncs, scheduled syncs and webhooks for one seller run one at a
time, so an item that goes low is only alerted once.

## Phase 5: dashboard API
Every agent decision is saved to the `decisions` table (before the Slack post,
so a Slack outage can't lose one). `action_taken` is the agent's
*recommendation* - `fulfill`, `hold`, `low_stock_alert`, or `unknown` if the
verdict line couldn't be parsed. Nothing is changed in Shopify yet.

Read endpoints for the dashboard (all need the seller's JWT):
- `GET /api/orders` - synced orders, newest first (`status` = fulfillment, plus `financial_status`)
- `GET /api/inventory/low-stock` - items at or below their threshold
- `GET /api/decisions?limit=50` - agent decisions, newest first (limit 1-200)
- `GET /api/inventory` - every tracked item with its threshold, low ones first
- `PATCH /api/inventory/:id` with `{ "low_stock_threshold": 3 }` - an item counts as low at or below this
- `PUT /api/settings/inventory` with `{ "default_low_stock_threshold": 5, "apply_to_all": false }` -
  what new items start with (`apply_to_all` also resets every existing item)

Syncs never overwrite a threshold the seller set. Changing a threshold doesn't
send an alert by itself; alerts come when stock drops past it.

Existing database? Create the new table with the `CREATE TABLE decisions`
block from `schema.sql`.

### Dashboard UI
The dashboard is a separate Next.js app, `ai-ops-dashboard`, which runs on
port 3005 and proxies `/api/*` to this backend. See that project's README.
This backend only serves the API.
