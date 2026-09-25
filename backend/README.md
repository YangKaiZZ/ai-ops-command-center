# AI Ops Command Center — Backend

Express + MySQL REST API for the AI Ops Command Center: multi-tenant
accounts, Shopify connection and webhooks, the order/stock agent, alerts,
and the endpoints the dashboard and the MCP server use.

## What's here
- `migrations/` — the database schema as numbered migrations; `001_initial_schema.sql` has every table (multi-tenant: each is scoped by `seller_id`)
- `src/db/` — the migrator that applies them
- `src/app.js`, `src/server.js` — the Express app, and the entrypoint that starts it with the scheduler and Telegram polling
- `src/routes/`, `src/controllers/` — endpoints: auth, orders, inventory, store, Shopify OAuth, webhooks, settings, alerts, decisions
- `src/middleware/` — JWT/API-key auth (`req.sellerId`), session-only routes, Shopify webhook HMAC check
- `src/services/` — the agent (`agentService`, `mcpClient`, `stockCheck`), restock forecasts (`restockForecast`), Shopify (`shopifyService`, `shopifyOAuth`, `syncService`, `webhookSetup`, `storeConnection`), alerts (`notifier`, `email`, `telegram`), the job queue (`jobQueue`, `jobHandlers`) and the scheduled sync
- `src/models/` — database access
- `scripts/` — `migrate`, `register-webhooks`, and the integration tests (`test-agent-flow`, `test-onboarding`, `test-alerts`, `test-agent-limit`, `test-jobs`, `test-rate-limits`, `test-password-reset`, `test-order-queries`, `test-order-detail`, `test-migrations`)
- `tests/` — unit tests (`npm test`)

## Run it locally
1. MySQL 8 (or run the whole stack with Docker instead: see [deploy](../deploy)).
2. Copy `.env.example` to `.env` and fill in your DB password, plus a random
   `JWT_SECRET` and `ENCRYPTION_KEY` (the server refuses to start without them).
   Generate each with:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   Shopify access tokens are encrypted with `ENCRYPTION_KEY` before they're
   stored. Keep the key safe: without it, stored tokens can't be read.
3. Install deps, create the database, and run:
   ```
   npm install
   npm run migrate    # creates the ai_ops database and its tables; run it again after pulling changes
   npm run dev
   ```
4. Test it:
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
it as a subprocess), so it takes the [mcp](../mcp) folder as a
second build context:

```
docker build --build-context mcp=../mcp -t ai-ops-backend .
```

The container runs `npm run migrate` before starting, and takes its settings
from environment variables (no `.env` inside the image). To run the whole app
on a server, use the [deploy](../deploy) folder's Docker
Compose setup and its README.

## Database migrations
The schema lives in `migrations/` as numbered files. Each runs once per
database, in number order, and is recorded in `schema_migrations` with a
checksum of its text.

```
npm run migrate                          # apply what's pending (creates the database if needed)
npm run migrate:status                   # applied / pending / changed, per file
npm run migrate:new -- add_line_items    # creates migrations/NNN_add_line_items.sql
```

- **A change to the schema is a new file.** Plain SQL, or a `.js` file
  exporting `async up(db)` for data changes. Once a migration has run
  anywhere, don't edit it: the next run stops, naming the file, if its text
  changed. (Windows and Linux line endings count as the same text.)
- **Forward only.** MySQL commits each schema change on its own, so there's no
  reliable rollback; undo with a new migration, or restore a backup
  ([deploy](../deploy) has the backup script). If a migration fails partway,
  the error says so; check what it already changed before running again.
- **One at a time.** A named MySQL lock (`migrate:<database>`) makes a second
  run wait, so two backends starting together can't both migrate.
- **Databases from before this** (created from the old `schema.sql` and
  upgraded by the old `npm run migrate` checks) are adopted on their first
  run: those checks, kept in `src/db/legacyUpgrade.js`, bring the database up
  to `001_initial_schema.sql`, which is then recorded as applied.

`npm run test:migrations` runs all of this against throwaway databases.

## Connecting a store
Sellers connect from the dashboard's Settings page, one of two ways.

**Connect with Shopify** (OAuth). The seller types their store address,
approves the app on Shopify and lands back on Settings. The backend then
registers the webhooks and imports orders and products in the background.
It needs these in `.env`:
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`: client ID and secret of your app in the Shopify Dev Dashboard
- `APP_URL`: this backend's public https URL (an ngrok tunnel while developing)
- `DASHBOARD_URL`: where the dashboard runs (default `http://localhost:3005`); links in emails and alerts point here
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

## The agent
Two triggers run the same agent loop (`src/services/agentService.js`):
1. **New order** — Shopify calls `POST /api/webhooks/orders-create`. The HMAC
   signature is verified against `SHOPIFY_API_SECRET`, the order is stored,
   and the agent decides if it's fulfillable.
2. **Low stock** — any tracked item that goes from above its threshold to
   at/below it triggers the agent, whether the drop arrives by an
   `inventory_levels/update` webhook, a scheduled sync or `POST /api/inventory/sync`.
   The event comes with those items' restock forecasts (see "Restock
   forecasts" below), so the alert can say when each runs out, how many to
   reorder and how much order history that's based on.

The agent calls DeepSeek (`deepseek-chat`, via the OpenAI SDK) and gets the
[MCP server](../mcp)'s read-only tools — the backend spawns that server with a
10-minute JWT for the seller in question. The decision is saved, then sent to
every alert channel the seller turned on (Slack, email, Telegram), or to the
server console if none is.

**Learning from the seller's ratings.** Before each run the agent also gets
the seller's recent ratings of its calls on the same kind of event (orders,
or low stock): every call marked wrong, and calls marked right that came with
a note, newest first, at most 8 from the last 90 days (`recentFeedback` in
`src/models/decisionModel.js`). Each is the call's verdict line, what the
seller said and their note. The prompt treats the notes as how this store
works (e.g. "bank transfers always show pending first; ship them"): the agent
applies them where they fit, says so in a bullet when one changed its call,
and never lets them override the stock check. Notes go to DeepSeek with those
later events. `npm run test:agent-feedback` checks what's sent, against a
fake DeepSeek.

**Daily limits.** So no account (or crowd of new accounts) can run up the
LLM bill, runs are capped over any 24 hours: `AGENT_DAILY_LIMIT_PER_ACCOUNT`
(default 50) per seller and `AGENT_DAILY_LIMIT_TOTAL` (default 200) for all
sellers together; `0` turns the agent off. Each run makes at most 6 model
calls, so the worst case is known up front. Runs that went ahead are counted
in `agent_runs` (`src/services/agentBudget.js`). An event over a limit is
still saved, as a `skipped` decision that says which limit it hit, but the
model isn't called and no alert is sent. `npm run test:agent-limit` checks
this against a fake DeepSeek.

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

**Rating from alerts.** Each decision alert comes with "Right call" and
"Wrong call" buttons, so the seller can rate it where they read it:
- Telegram: real buttons. A tap rates the decision at once (the bot answers,
  and ticks the button); it only counts from the chat linked to the account
  the decision belongs to. After "Wrong call" the bot asks what it should
  have done, and a reply to that question becomes the note.
- Slack and email: links to a rating page in the dashboard (`/rate`), with
  the choice already made and a note box. Incoming webhooks can't receive
  clicks, and mail scanners open links by themselves, so opening a link
  never saves anything: the page's Save button does. Each link carries a
  signed token for that one decision (`src/services/ratingLinks.js`, keyed
  off `JWT_SECRET`), expires after 30 days, and points at `DASHBOARD_URL`.
- `GET /api/rate/:token` shows the decision (order, verdict, first line,
  rating); `PUT /api/rate/:token` with `{ "feedback", "note" }` rates it, as
  on the dashboard. No sign-in: the token is the permission.

## Daily summary and late orders
Two reports a seller can turn on in Settings, both sent to their alert
channels and worked out in code (no model call), in `src/services/reports.js`:
- **Daily summary**, at an hour the seller picks in their time zone: the day
  before's orders and sales against the day before that, what needs action
  and the oldest unshipped order, late orders, stock running low and what
  runs out this week (from the restock forecasts), and the agent's decisions
  with how they were rated, plus a nudge to rate the week's unrated ones.
- **Late orders**: a paid (or authorized) order still not shipped after 12,
  24, 48 or 72 hours. One alert names the orders that turned late since the
  last one; each order is named once (`orders.late_alerted_at`). Only orders
  from the last 14 days are alerted, so turning it on doesn't bring up old
  history; the summary counts them all.

Every `REPORT_CHECK_MINUTES` (default 5, `0` = off) the backend queues what's
due as jobs. The job keys (`summary:<seller>:<local date>`, and one per set
of late orders) make each summary and each alert happen once, whatever
restarts or repeated checks happen. Turning the summary on after its hour
starts it the next day. Days are in the seller's time zone
(`src/utils/timeZone.js`, built-in `Intl`, right on the days clocks change).
- `GET /api/settings` includes `reports: { timezone, summary: { enabled, hour },
  late_orders: { enabled, after_hours } }` (both off by default).
- `PUT /api/settings/reports` with the same shape (`after_hours` 12, 24, 48 or
  72; `timezone` an IANA name such as `Asia/Manila`).
- `POST /api/settings/reports/summary` sends today's summary now, as a
  preview; the scheduled one still comes.

`npm run test:reports` checks all of it against a fake mail server and a
fake Telegram: settings, the summary through the job queue, late orders,
the rating links and page API, and Telegram's buttons and note replies.

**API keys** let tools like the MCP server in Claude Desktop read a
seller's data without a sign-in token that expires in 7 days. Keys look
like `aiops_...`, are sent as `Authorization: Bearer <key>` on the same
endpoints, and only their SHA-256 hash is stored:
- `GET /api/settings/api-keys` - active keys (name, first characters, created, last used)
- `POST /api/settings/api-keys` with `{ "name": "Claude Desktop" }` - the response is the only time the key is shown
- `DELETE /api/settings/api-keys/:id` - revoke; it stops working immediately

Everything under `/api/settings` needs a signed-in session: an API key can
read and sync store data, but can't change Slack or create more keys.

Settings in `.env`: `SHOPIFY_API_SECRET`, `DEEPSEEK_API_KEY`,
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
being tracked. An order sync also fetches the line items of orders from the
last 90 days that were saved before line items were kept (100 per request),
so restock forecasts count what they sold.

**Restock forecasts.** `src/services/restockForecast.js` works out in code
how fast each tracked item sells, from the stored line items of the last
`days` (default 30; refunded and voided orders don't count). If the store's
first order is more recent than that, the history starts there, and a
history under a day is read as one day. From that pace: days of stock left,
the date it runs out, and how many to reorder to last `cover_days` (default
30; oversold units are added). Every forecast says what it's based on (units,
orders, days of history) and is marked `low` confidence under 3 orders or 7
days of history. `npm run test:forecast` checks it against a fake Shopify.

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

## Background jobs
Agent runs, and the stock re-reads that `inventory_levels/update` webhooks
ask for, go through a job queue in MySQL (the `jobs` table,
`src/services/jobQueue.js`) instead of running inside the request:
- A job is saved before the webhook or sync that caused it is answered, so a
  restart can't lose it. If saving fails, the webhook gets a 500 and Shopify
  sends it again.
- A worker in the backend process runs `JOB_CONCURRENCY` jobs at a time
  (default 2), claiming them with `SELECT ... FOR UPDATE SKIP LOCKED`.
- A failed job is retried after 30 seconds, then 2 minutes (3 tries in all).
  Errors that waiting won't fix, like a missing DeepSeek key, fail at once.
  Each model call times out after 60 seconds.
- On shutdown (SIGTERM, e.g. `docker compose stop`) the backend stops taking
  jobs and gives running ones up to 25 seconds to finish. Jobs still marked
  running at the next start are queued again. So a job runs at least once:
  an agent run cut off after saving its decision could save a second one.
- One agent run per order (`dedupe_key`), however many times Shopify delivers it.
- Webhook delivery ids (`X-Shopify-Webhook-Id`) are kept in
  `webhook_deliveries`, so a redelivery is recognised after a restart too.
- An order's job holds only what the agent reads (id, number, total, line
  items), never customer details.
- Finished jobs are kept for 30 days, delivery ids for 7.

This assumes one backend process, as the per-seller locks already do.
`npm run test:jobs` checks all of it against a fake DeepSeek.

## Invite-only sign-up

Set `SIGNUP_INVITE_CODE` in `.env` and `POST /api/auth/register` must include
a matching `invite_code` (403 otherwise). Empty or unset means anyone can sign
up. It is one shared code, not per-person invites; change it (and restart) to
retire it. Existing accounts are unaffected.
- The check is constant-time, and 10 wrong codes per IP per hour stop guessing
  (429, even for the right code from that address).
- `GET /api/auth/config` returns `{ "invite_required": true|false }`, which is
  how the dashboard's sign-up page knows whether to show the field.
- Shopify's install link sends new stores through the same sign-up page, so
  they need the code too.
- The tests clear the variable so a code in your `.env` doesn't break them.

## Sign-in rate limiting

Failed attempts are recorded in `rate_limit_events` (`src/services/rateLimit.js`):
- 10 failed sign-ins per email and 30 per IP per 15 minutes; 10 sign-ups per
  IP per hour. Over the limit gives a 429 with `Retry-After`.
- Emails and IPs are stored only as keyed hashes (`keyedHash()` in
  `src/config/secrets.js`), never in the clear.
- A successful sign-in clears that account's failures. Requests from localhost
  are exempt from the per-IP limits only, so local development isn't blocked.
- Unknown emails take as long to reject as wrong passwords, and give the same
  message, so the response doesn't reveal which accounts exist.
- Behind a reverse proxy set `TRUST_PROXY` (compose sets `1` for Caddy) so the
  client IP comes from `X-Forwarded-For`; without it every request looks like
  it comes from the proxy.
- Old events are pruned by the job worker.

`npm run test:rate-limits` checks it through the real routes.

## Password reset

`POST /api/auth/forgot-password` with `{ "email" }` emails a reset link
(`DASHBOARD_URL/reset-password?token=...`); `POST /api/auth/reset-password`
with `{ "token", "password" }` sets the new password. It needs `SMTP_URL` and
`EMAIL_FROM`; without them forgot-password answers 503.
- Links are random 256-bit tokens stored only as SHA-256 hashes
  (`password_resets`), work once, and expire after an hour. Asking again
  replaces the older link.
- forgot-password answers the same 202 for every valid-looking email and sends
  the mail after answering, so it can't be used to find out who has an account.
- Limits (`rateLimit.js`): 3 emails per address per hour (with or without an
  account), 10 requests per IP per hour, and 20 bad links per IP per 15 minutes.
- A reset sets `sellers.password_changed_at`; sign-in tokens issued before it
  are refused (the auth middleware checks it), so a stolen 7-day token dies
  with the old password. API keys are unaffected, they can be revoked in Settings.
- A reset also lifts that account's sign-in lockout. It doesn't sign anyone in.

`npm run test:password-reset` checks it against a fake SMTP server.

## Dashboard API
Every agent decision is saved to the `decisions` table (before any alert is
sent, so an outage can't lose one). `action_taken` is the agent's
*recommendation* - `fulfill`, `hold`, `low_stock_alert`, or `unknown` if the
verdict line couldn't be parsed. Nothing is changed in Shopify yet.

The seller can rate each decision thumbs up (the right call) or down, with an
optional note (`feedback`, `feedback_note`, `feedback_at`), which gives the
agent an accuracy figure and teaches it (see "Learning from the seller's
ratings" above). Skipped runs can't be rated: the agent never saw
the order. Notes are the seller's own words, so the privacy webhooks treat
them like the agent's text: a customer's name is scrubbed from them, and
they're included in data requests.

Endpoints for the dashboard (all need the seller's JWT):
- `GET /api/orders` - synced orders, newest first, a page at a time: `{ orders, total, limit, offset }`.
  Each order has `status` (fulfillment), `financial_status` and `latest_decision` (the agent's most
  recent verdict and reasoning, or null). Query: `limit` (1-200, default 50), `offset`, `status`
  (unfulfilled, partial, fulfilled, restocked), `financial_status` (paid, pending, refunded, ...),
  `from` / `to` (a UTC day `YYYY-MM-DD`, whole day included, or an ISO date-time), `number`
  (`#1001` or `1001`, exact), `q` (part of an order number or customer name) and
  `needs_action=true` (the same rule as the pending list). Filters combine. Bad values get a 400
  saying what's allowed; `total` counts every match.
- `GET /api/orders/pending` - orders that need action, oldest first: `{ pending_orders, total, limit, offset }`
- `GET /api/orders/:id` - one order: `{ order, line_items, line_items_note, decisions, shopify_admin_url }`.
  `decisions` is every agent decision about it, newest first, with its rating. Line items are saved from the order
  payloads the sync and webhooks already get (`order_line_items`; product details only, never the
  free-text `properties`). Orders saved before that are fetched from Shopify once, on their first
  view; if that can't happen, `line_items` is null and `line_items_note` says why.
- `GET /api/overview?from=<ISO date-time>` - the dashboard's key numbers for a period (default the
  last 7 days; `from` at most 31 days back) next to the same length of time before it:
  `{ period, orders, stock, decisions }`. `orders`: `count` and `previous_count` (every order
  placed), `sales` and `previous_sales` (order totals, refunded and voided left out),
  `needs_action` and `oldest_unshipped`. `stock`: `tracked`, `low` (out of stock included),
  `out_of_stock`, `to_reorder`, `running_out` (items that run out within 7 days, from the restock
  forecasts) and what the forecasts are based on. `decisions`: this period's count per verdict,
  and `ratings` of those decisions (as below).
- `GET /api/inventory/low-stock` - items at or below their threshold
- `GET /api/decisions?limit=50` - agent decisions, newest first (limit 1-200), each with its
  rating: `{ decisions, ratings }`. `ratings` covers every decision so far, not just this page:
  `up`, `down`, `unrated` (skipped runs left out) and the same per verdict in `by_verdict`.
- `PUT /api/decisions/:id/feedback` with `{ "feedback": "down", "note": "Should have held" }` -
  rate a decision `up` or `down` (the note is optional, up to 500 characters); `null` clears the
  rating and its note. Returns `{ id, feedback, feedback_note, feedback_at }`. A skipped run gets a
  400; another seller's decision a 404.
- `GET /api/inventory` - every tracked item with its threshold, low ones first
- `GET /api/inventory/forecast?days=30&cover_days=30` - restock forecasts, soonest to run out
  first: `{ lookback_days, cover_days, history, items }`. `history` is what they're based on:
  `from`, `days`, `orders` counted and `orders_missing_items` (in that stretch, but items not
  fetched yet). Each item adds `units_sold`, `orders`, `per_day`, `days_left` (0 when out of
  stock, null when not selling), `runs_out_at`, `reorder_quantity` and `confidence` (`low` or
  `normal`). `days` is 1-90, `cover_days` 1-180.
- `PATCH /api/inventory/:id` with `{ "low_stock_threshold": 3 }` - an item counts as low at or below this
- `PUT /api/settings/inventory` with `{ "default_low_stock_threshold": 5, "apply_to_all": false }` -
  what new items start with (`apply_to_all` also resets every existing item)

Syncs never overwrite a threshold the seller set. Changing a threshold doesn't
send an alert by itself; alerts come when stock drops past it.

### Dashboard UI
The dashboard is a separate Next.js app in [dashboard](../dashboard), which
runs on port 3005 and proxies `/api/*` to this backend. See its README.
This backend only serves the API.
