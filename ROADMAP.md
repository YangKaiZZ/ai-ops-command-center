# Roadmap

What's next for AI Ops Command Center, grouped by theme. Done items are
listed at the end.

## Write actions

- **Approve and Hold that act, not just advise.** Approve fulfills the order
  in Shopify; Hold tags it and emails the customer. Buttons in the dashboard
  and in Slack. Needs write scopes from Shopify, which the app doesn't request
  yet.
- **Restock forecasting**, e.g. "X runs out in ~4 days, reorder 40". Needs
  order line items stored, which the orders table doesn't have yet.
- **Daily morning summary**: yesterday's orders and revenue, what needs
  action, what's running low.
- **Late-order alerts** for orders still unfulfilled after 24-48 hours.
- **Risk triage**: Shopify's fraud risk score and billing/shipping mismatch
  as reasons to hold.
- **In-dashboard chat** using the same tools. Host the MCP server remotely
  with OAuth, so power users paste a URL instead of editing JSON.
- **MCP tool inputs** (limit, status, date range, single-order lookup):
  `get_all_orders` currently puts every order into the model's context.
- **Longer term**: multi-channel stock (Shopee, TikTok Shop).

## Dashboard

- **Overview page** with the key numbers.
- **Order detail view** with line items and an "Open in Shopify" link.
- **Search, filters and pagination**: `/api/orders` currently returns every
  order with no limit.
- **Thumbs up/down on each agent decision**, to get an accuracy figure.

## Done: before production

- Job queue in MySQL: retries, survives restarts, one run per order.
- Versioned database migrations with checksums and a lock.
- Daily caps on agent runs, per account and in total.
- Sign-in and sign-up rate limiting.
- Password reset by emailed link, signing out older sessions.
- Invite-only sign-up (`SIGNUP_INVITE_CODE`).
