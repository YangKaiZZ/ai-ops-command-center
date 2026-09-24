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

## Next steps (Phase 2)
- Get Shopee Open Platform API access (partner account + app registration —
  takes a few days for approval, so start this NOW in parallel with Phase 1).
- Replace the empty `orders`/`inventory_items` tables with real synced data
  from Shopee's API.
- Add a `POST /api/orders/sync` endpoint that pulls fresh data on demand.

## Phase 4: event-triggered agent
Two triggers run the same agent loop (`src/services/agentService.js`):
1. **New order** — Shopify calls `POST /api/webhooks/orders-create`. The HMAC
   signature is verified against `SHOPIFY_WEBHOOK_SECRET`, the order is stored,
   and the agent decides if it's fulfillable.
2. **Low stock** — after `POST /api/inventory/sync`, any tracked item that went
   from above its threshold to at/below it triggers the agent.

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

Settings in `.env`: `SHOPIFY_WEBHOOK_SECRET`, `DEEPSEEK_API_KEY`,
`MCP_SERVER_PATH` (see `.env.example`).

Test everything up to the LLM call with a signed fake order (backend running):
```
npm run test:agent
```

To receive real webhooks, expose the backend publicly (e.g. `ngrok http 3000`)
and register `https://<tunnel>/api/webhooks/orders-create` for the
`orders/create` topic, then set `SHOPIFY_WEBHOOK_SECRET` to the secret Shopify
signs with (your app's client secret).

## Phase 5: dashboard API
Every agent decision is saved to the `decisions` table (before the Slack post,
so a Slack outage can't lose one). `action_taken` is the agent's
*recommendation* - `fulfill`, `hold`, `low_stock_alert`, or `unknown` if the
verdict line couldn't be parsed. Nothing is changed in Shopify yet.

Read endpoints for the dashboard (all need the seller's JWT):
- `GET /api/orders` - synced orders, newest first (`status` = fulfillment, plus `financial_status`)
- `GET /api/inventory/low-stock` - items at or below their threshold
- `GET /api/decisions?limit=50` - agent decisions, newest first (limit 1-200)

Existing database? Create the new table with the `CREATE TABLE decisions`
block from `schema.sql`.

### Dashboard UI
The dashboard is a separate Next.js app, `ai-ops-dashboard`, which runs on
port 3005 and proxies `/api/*` to this backend. See that project's README.
This backend only serves the API.
