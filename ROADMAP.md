# Roadmap

What's next for AI Ops Command Center, grouped by theme. Done items are
listed at the end.

## Write actions

- **Remote MCP server**: host it with OAuth, so power users paste a URL
  into Claude instead of editing JSON.
- **Longer term**: multi-channel stock (Shopee, TikTok Shop).

## Smaller ideas

- Real Slack interactivity, for one-click rating inside Slack.

## Shopify platform

- **Next API version before July 2027**: `2026-07` is supported until
  2027-07-16. Move `API_VERSION` on and re-run the live read check.

## Going live for other stores

Separate from the code, and needed before anyone but the owner connects:

- Shopify's approval for protected customer data. Until then Shopify leaves
  customer names and emails out of orders, so orders show no customer name.
- How stores install it: a private install link or an App Store listing
  (which needs Shopify's review).
- A privacy policy page.
- Opening sign-up (today it's invite-only).

## Done: before production

- Job queue in MySQL: retries, survives restarts, one run per order.
- Versioned database migrations with checksums and a lock.
- Daily caps on agent runs, per account and in total.
- Sign-in and sign-up rate limiting.
- Password reset by emailed link, signing out older sessions.
- Invite-only sign-up (`SIGNUP_INVITE_CODE`).

## Done since

- Orders come a page at a time with a total, filterable by status, payment
  status, date range and order number; the Orders page is paginated.
- Search and filters on the Orders page: order number or customer, shipping
  and payment status, a date range in the seller's time zone, and "needs
  action", all kept in the URL.
- Order detail page: line items (now stored from the orders Shopify already
  sends), every agent decision with its reasoning, and "Open in Shopify".
- MCP tools take matching inputs (`limit`, `offset`, `status`,
  `financial_status`, `from`/`to`) and return a page with `total` and
  `next_offset`; `get_order` looks one order up with the agent's reasoning.
- Restock forecasting, e.g. "runs out in about 4 days, reorder 40", from
  stored line items, always saying how much order history it's based on
  (`GET /api/inventory/forecast`). It's on the Stock page (with a Reorder
  tab), in low-stock alerts, and in the `forecast_restock` MCP tool. The order
  sync fetches the items of older orders from the last 90 days so their sales
  count.
- Overview page, the dashboard's landing page: the last 7 days against the 7
  before (orders, sales, what needs action), stock that's low, to reorder or
  running out within a week, and the agent's decisions by verdict, each
  linking to the filtered page (`GET /api/overview`).
- Thumbs up/down on each agent decision, with an optional note: the share
  rated right on the Decisions page (overall and per verdict, with filters
  for not rated and marked wrong) and on the Overview
  (`PUT /api/decisions/:id/feedback`).
- The agent learns from those ratings: before each decision it reads the
  seller's recent wrong calls and notes on similar events, applies them
  where they fit and says when one changed its call (never over the stock
  check).
- Daily summary at an hour the seller picks, in their time zone: yesterday
  against the day before, what needs action, late orders, stock running out
  and the agent's decisions with their ratings.
- Late-order alerts: paid orders still not shipped after 12, 24, 48 or 72
  hours, each named once.
- Rating decisions from the alert itself: one tap (and a reply for the note)
  in Telegram; a signed, expiring rating page from Slack and email.
- Risk triage: each order's run reads Shopify's fraud analysis (risk level,
  recommendation, reasons, whether the billing and shipping addresses match).
  High risk is a hold the model can't overrule; medium risk is a hold unless
  the seller's notes say otherwise. A pending check is waited for, recent open
  orders are checked again at each sync, and a risk that rises after the agent
  decided is alerted. On the Orders page (a risk badge and a "Flagged for
  fraud" filter), each order's page, the orders API (`?risk=flagged`) and the
  MCP tools.
- Hold and fulfill in Shopify: real Shopify holds with a reason, released
  only when this app placed them, and fulfillments with tracking and an
  optional email to the customer, offered only when Shopify allows them now.
  Auto-hold (a setting, off by default) turns the agent's HOLD into a Shopify
  hold, and holds a fraud risk that rises after a FULFILL; the alert says how
  it went. Every attempt is logged with Shopify's answer; API keys can't act.
  In the dashboard: an "In Shopify" panel on each order's page, links from
  HOLD and FULFILL decision cards, and the auto-hold switch in Settings.
- Shopify API version pinned to `2026-07` in one place, replacing the retired
  `2024-10` (which Shopify was answering with `2025-10`, itself retired in
  October 2026). Checked read-only against a dev store on both versions:
  the same order, product, variant, webhook and fraud-check fields, and the
  hold and fulfill inputs in the GraphQL schema.
- "Flagged for fraud" on the Overview (a tile: this period, the one before,
  and any still needing action) and a fraud line in the daily summary.
- Hold and fulfill from the alert itself: "Hold in Shopify" and "Mark
  fulfilled" on order and fraud-risk alerts. Slack and email open a signed
  confirm page (one order, one action, 7 days) with the same form as the
  order's page; Telegram asks Yes / Cancel in the chat, with the hold reason
  picked from the fraud check or payment. Logged as done from an alert or
  from Telegram. Only offered when the store allows it.
- MCP 1.4.0: `get_decisions` and `rate_decision`, so the seller can ask
  Claude Desktop which calls aren't rated yet and rate them with a note (the
  agent reads those). The agent itself doesn't get either tool.
- "Try the demo" on the sign-in page: a sample store per visitor (a month of
  orders, fraud checks, rated decisions, forecasts), with hold and fulfill
  against a stand-in for Shopify; no Shopify or model calls, nothing that
  reaches outside, deleted after 4 hours (migration 010).
- Every Shopify call goes through the GraphQL Admin API (App Store apps must
  use GraphQL only): orders, stock, webhook subscriptions, granted scopes and
  uninstalling, alongside the fraud checks and fulfillment that already did.
  Orders and variants are mapped to the field names Shopify's webhooks use,
  so an order looks the same whichever way it came in. Checked read-only
  against the dev store: the same orders, items, statuses and stock as REST.
  Customer names Shopify refuses without approval are left empty, as before,
  and come through once it approves.
- Faster late fraud results: the `orders/risk_assessment_changed` webhook
  (GraphQL-only) has an order's fraud check read again as soon as it changes,
  so a risk that rises after the agent decided is alerted in seconds, for any
  open order, not only at the next sync for last week's. Connected stores
  get the new webhook when the backend starts.
- Chat in the dashboard: questions about the store in the seller's words,
  answered by DeepSeek with the agent's MCP tools plus the decision history,
  read-only. Order numbers in answers link to the order; the conversation
  stays in the browser tab. Signed-in sellers only (not API keys, not the
  demo), with its own daily caps (`CHAT_DAILY_LIMIT_PER_ACCOUNT`, `_TOTAL`).
