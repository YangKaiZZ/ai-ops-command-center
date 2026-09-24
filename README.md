# AI Ops Dashboard (Phase 5)

Next.js + Tailwind dashboard for the AI Ops Command Center. It reads the
[ai-ops-backend](../ai-ops-backend/ai-ops-backend) API and shows a seller's
orders, the agent's decisions, and low stock.

## Pages
- `/orders`: every synced order with its shipping status, payment status and the agent's latest verdict
- `/decisions`: the agent's decisions, newest first, as cards (order, verdict, headline, reasoning as bullets)
- `/low-stock`: one bar per item against its threshold; red = out of stock, amber = low
- `/settings`: store connection status; the seller's own Slack channel for agent decisions (set, switch, remove); API keys for the MCP server in Claude Desktop (create, shown once; revoke)

The first three pages share one data layer (`src/components/DashboardProvider.tsx`).
It refreshes every 30 seconds, and "Sync from Shopify" calls the backend's
sync endpoints. An inventory sync can trigger the low-stock agent, which
posts to Slack.

## Run it
The backend must be running on port 3000.

```bash
npm install
npm run dev      # http://localhost:3005
```

Sign in with a seller account. It uses the same sign-in as the backend
(`POST /api/auth/login`). The JWT is stored in localStorage as
`aiops.session`, and any 401 sends you back to sign-in.

`/api/*` is proxied to the backend by a rewrite in `next.config.ts`, so the
browser only talks to this app and the backend needs no CORS. Set
`BACKEND_URL` to point somewhere other than `http://localhost:3000`.

## Checks
```bash
npm test         # verdict/stock-color/reasoning helpers
npm run lint
npm run build
```
