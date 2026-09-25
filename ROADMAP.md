# Roadmap

What's next for AI Ops Command Center, grouped by theme. Done items are
listed at the end.

## Write actions

- **Approve and Hold that act, not just advise.** Approve fulfills the order
  in Shopify; Hold tags it and emails the customer. Buttons in the dashboard
  and in Slack. Needs write scopes from Shopify, which the app doesn't request
  yet.
- **Daily morning summary**: yesterday's orders and revenue, what needs
  action, what's running low.
- **Late-order alerts** for orders still unfulfilled after 24-48 hours.
- **Risk triage**: Shopify's fraud risk score and billing/shipping mismatch
  as reasons to hold.
- **In-dashboard chat** using the same tools. Host the MCP server remotely
  with OAuth, so power users paste a URL instead of editing JSON.
- **Longer term**: multi-channel stock (Shopee, TikTok Shop).

## Dashboard

- **Overview page** with the key numbers.
- **Thumbs up/down on each agent decision**, to get an accuracy figure.

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
