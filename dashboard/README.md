# AI Ops Command Center — Dashboard

Next.js + Tailwind dashboard for the AI Ops Command Center. It reads the
[backend](../backend) API and shows a seller's
orders, the agent's decisions, and stock.

## Pages
- `/signup`: business name, email, password; then on to Settings to connect the store. Shopify's install link sends new stores here as `/signup?shop=<store>.myshopify.com`, and that store is carried through to Settings (also via "Sign in" for an existing account)
- `/login`: sign-in, with links to sign-up and to password reset
- `/forgot-password`: asks for a reset link by email (the answer is the same whether or not the address has an account)
- `/reset-password?token=...`: the page the emailed link opens; sets a new password and signs out older sessions
- `/overview` (where `/` and sign-in land): the setup checklist while it's needed, then the key numbers for the last 7 days (today included) next to the 7 days before: orders, sales (refunded and voided orders left out), orders that need action and the oldest unshipped one; items running low, items to reorder and what runs out within 7 days (from the restock forecasts, with the history they're based on); and the agent's decisions by verdict with how many were rated right. Each tile opens the matching page, already filtered (e.g. `/orders?from=…`, `/orders?needs_action=1`, `/stock?show=reorder`)
- `/orders`: a setup checklist until the store is connected and an alert channel is on, then the synced orders, newest first and 50 to a page, with shipping status, payment status and the agent's latest verdict. Orders Shopify's fraud check flagged (high or medium risk, or it advises cancelling or checking with the buyer) get a risk badge next to their number, and so do orders whose check hasn't finished; hovering shows what Shopify said. Search (order number or customer), shipping and payment status, a date range in the seller's own time zone, "Needs action" and "Flagged for fraud" narrow the list; all of it is kept in the URL (`/orders?q=smith&needs_action=1&risk=flagged&page=2`) so reloads and shared links keep the view. Each order number opens its page
- `/orders/<id>`: one order: customer, total, statuses, Shopify's fraud check (its risk level and advice, what raised the risk, whether the billing and shipping addresses match, and when it was checked), what was in it (items, quantities, how many are still to ship, prices), every agent decision about it with the reasoning and its rating, and "Open in Shopify". "Back to orders" returns to the filtered list it came from
- `/decisions`: the agent's decisions, newest first, as cards (order, verdict, headline, reasoning as bullets). Each card asks "Right call?" with thumbs up (Yes) and down (No), saved on click; clicking the pressed one again clears it. A No opens an optional note ("What should it have done?"). Above the cards: the share rated right over every decision so far, per verdict too, and filters for All, Not rated and Marked wrong (`?show=unrated`, `?show=wrong`). A card rated under a filter stays in view until the page is reloaded. Skipped runs can't be rated
- `/stock`: one bar per item against its own low-stock level, which can be edited in place; shows low items, items to reorder (soonest to run out first) or all items, kept in the URL (`?show=reorder`, `?show=all`). Red = out of stock, amber = low. Under each bar, the restock forecast: how fast it sells, when it runs out, how many to reorder, and "rough estimate" when it's based on little data; a line at the top says how much order history the forecasts use. (`/low-stock` redirects here.)
- `/rate?t=<token>&r=up|down`: where the Right call / Wrong call buttons in Slack and email alerts lead. No sign-in (the signed token names one decision): it shows the decision with that choice made and a note box, and saves only on Save, since mail scanners open links by themselves. An expired or broken link says so
- `/settings`: connect the store (Connect with Shopify, or a pasted Admin API token) and disconnect it; alerts by Slack, email (confirmed with a code) and Telegram, with a test alert; the daily summary (on/off, hour, time zone, "Send a summary now") and late-order alerts (on/off, after 12-72 hours); the default low-stock level; API keys for the MCP server in Claude Desktop; customer data requests

The dashboard pages share one data layer (`src/components/DashboardProvider.tsx`).
It refreshes every 30 seconds, and "Sync from Shopify" calls the backend's
sync endpoints (disabled until a store is connected). An inventory sync can
trigger the low-stock agent, which sends an alert.

## Look
One dark theme: graphite surfaces (`#13161C` page, `#1F232B` cards,
`#2E3542` edges) and a single accent, "Lime Compute" `#B6FF2E`, kept for main
actions, the current tab and what's going well. The color tokens live in
`src/app/globals.css`; statuses are always a translucent pill with an icon
and a word, never color alone. Text is Inter, small labels JetBrains Mono,
both in `src/app/fonts` (SIL Open Font License) and loaded with
`next/font/local`, so builds need no network and pages make no font requests.
Icons are [Phosphor](https://phosphoricons.com), imported one file each from
`src/components/icons.ts` so only those are bundled.

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

## Docker
The `Dockerfile` builds a standalone server (`output: "standalone"`, turned on
by `NEXT_OUTPUT=standalone` in the image build only). `BACKEND_URL` is a build
argument because Next bakes rewrites in at build time:

```bash
docker build --build-arg BACKEND_URL=http://backend:3000 -t ai-ops-dashboard .
```

To run the whole app on a server, use the [deploy](../deploy)
folder's Docker Compose setup and its README.

## Checks
```bash
npm test         # verdict/stock-color/reasoning/install-link/forecast-wording/overview helpers
npm run lint
npm run build
```
