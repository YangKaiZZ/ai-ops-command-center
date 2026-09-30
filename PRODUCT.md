# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: Shopify sellers running their own store.** They connect a store,
let an AI agent watch its orders and stock, and act on its calls: ship an
order, hold it, restock an item. When the two audiences below pull in
different directions, the seller wins.

- Which sellers exactly (a solo owner-operator or a small team with someone on
  fulfillment, order volume) is **not decided yet**: the first 1-2 real users
  will be whoever says yes, found through a Reddit / Shopify Community post or
  people the owner knows. Revisit this section once they're using it.
- Where they use it: **the dashboard at a desk; on the phone, mostly the
  alerts** (email, Telegram, Slack) and the confirm pages those alerts open.
  The dashboard must still work at phone width, but phone-first design is for
  the alert-to-action path.

**Secondary: people evaluating the owner's portfolio** (hiring managers,
recruiters). They reach it through GitHub or the live site and the "Try the
demo" button. They should see a product that plainly works for sellers, not a
showcase built for them.

## Product Purpose

An AI operations assistant for Shopify stores. It watches orders and stock,
has an LLM agent decide what needs attention (fulfill, hold, restock), checks
each order against Shopify's fraud analysis, and tells the seller where they
already are (Slack, email, Telegram), with the action one tap away. The seller
rates each call and the agent reads those ratings and notes before similar
calls.

Success right now is 1-2 real sellers using it for free and giving feedback, a
testimonial and real usage numbers. It is a portfolio project: it is not going
on the Shopify App Store.

## Positioning

- The agent's calls are checked by code, not just the model: whether each line
  item can ship comes from Shopify's live stock, and a high fraud risk is a
  hold the model cannot overrule.
- It learns the store from the seller's own ratings and notes, and says when a
  note changed its call.
- The same tools run in the dashboard, in the alerts, in Chat, and in Claude
  Desktop through an MCP server.
- It acts in Shopify for real (holds with a reason, releases only its own
  holds, fulfillments with tracking), and only what Shopify allows right now.

## Operating Context

- Sellers sign up (invite code), connect with Shopify OAuth, and the first
  import brings in orders and stock.
- Daily loop: alerts arrive for new orders, low stock, rising fraud risk and
  late orders; the seller holds or fulfills from the alert or the order's page,
  and rates the call. A daily summary arrives at an hour they pick.
- Dashboard pages: Overview, Orders (and each order's page), Stock (with
  restock forecasts and a CSV reorder list), Decisions, Chat, Settings.
- Evaluators use "Try the demo": a private sample store per visitor, no
  Shopify or model calls, deleted after 4 hours.
- Live at https://ai-ops-drew.duckdns.org on a single VPS; alert email is sent
  from alerts@aiops-cocenter.site.

## Capabilities and Constraints

- **The seller stays in charge.** The agent recommends; Shopify only changes
  when the seller acts, or when they turn on auto-hold (off by default). The
  agent never ships anything. Chat is read-only.
- **The model is DeepSeek**, a Chinese AI provider. Real sellers must be told
  this before they connect.
- **Customer names are hidden** until Shopify approves the app for protected
  customer data (only first and last name are requested); orders show "Name
  not shared" until then.
- **Installing on a real seller's store** needs Shopify custom distribution,
  which is one store per app, so each real seller gets their own Shopify app.
- Sign-up is invite-only. Daily caps limit agent runs and Chat questions, per
  account and in total.
- Forecasts come from stored orders and always say how much history they're
  based on; under 3 orders or a week of history they're marked rough, and
  with no history there's no reorder number at all.
- Gift cards and products without stock tracking are left out of stock.
- Terminology in the product: the agent's **call** (a *decision* in the data),
  verdicts **Fulfill / Hold / Restock**, **Needs action**, **Flagged for
  fraud**, **Low at** (an item's low-stock level), **Right call / Wrong call**.

## Brand Commitments

- Name: **Arbiter Ops** (renamed from "AI Ops Command Center" on
  2026-09-30: "AIOps" is an IT-monitoring term, and the name was long and
  generic). The arbiter makes the call, the seller decides. The GitHub repo
  and the live address keep the old name for now.
- **Lime (#B6FF2E) is the brand color** and survives any redesign (user
  confirmed, 2026-09-29).
- **It must read as professional**: a tool a seller trusts with their store,
  not a novelty (user's words for the 2026-09-29 redesign: "just make it
  professional").
- No emoji anywhere in the UI; icons are Phosphor.
- Never invent business facts, customers, numbers or claims. Anything shown
  comes from the seller's own data or is labelled as a sample (the demo).
- Existing voice: plain, specific sentences that say what happened and what
  to do next, and name the reason when something can't be done.

## Evidence on Hand

- The live site and its demo, and the public repository
  (github.com/YangKaiZZ/ai-ops-command-center) with its README and ROADMAP.
- An end-to-end rehearsal as a new seller on a fresh Shopify dev store
  (2026-09-29): connect, first sync, email alerts, storefront order, the
  agent's call and alert, a low-stock alert, Chat on the real model, and
  account deletion uninstalling the app all worked.
- Page designs for the dashboard:
  `C:\Users\ASUS\Downloads\AI Ops Dashboard — Page Designs.html` (the shipped
  dashboard follows them).
- **None yet:** real sellers, testimonials, usage numbers, reviews or press.
  Future work must not imply any of these exist.

## Product Principles

1. **Recommend, don't act behind the seller's back.** Every change in Shopify
   is the seller's, or an opt-in rule they can see and switch off.
2. **Say what it knows and how it knows it.** Show the reason for every call,
   the history behind every forecast, and plainly what isn't available.
3. **Meet the seller where they are.** The alert is the product as much as the
   dashboard; acting from it must be safe and quick.
4. **The seller teaches it.** Ratings and notes are first-class, not a
   feedback widget.
5. **Safety over speed.** When fraud or stock says wait, it waits, and it says
   why.

## Accessibility & Inclusion

- A status is never shown by color alone: every status pill carries its text
  label.
- No formal standard has been set yet.
