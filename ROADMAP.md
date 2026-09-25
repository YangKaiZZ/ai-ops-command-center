# Roadmap

What's next for AI Ops Command Center, grouped by theme. Done items are
listed at the end.

## Write actions

- **Approve and Hold that act, not just advise.** Approve fulfills the order
  in Shopify; Hold tags it and emails the customer. Buttons in the dashboard
  and in Slack. Needs write scopes from Shopify, which the app doesn't request
  yet.
- **Risk triage**: Shopify's fraud risk score and billing/shipping mismatch
  as reasons to hold.
- **In-dashboard chat** using the same tools. Host the MCP server remotely
  with OAuth, so power users paste a URL instead of editing JSON.
- **Longer term**: multi-channel stock (Shopee, TikTok Shop).

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
