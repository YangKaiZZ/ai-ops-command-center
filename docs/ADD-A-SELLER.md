# Adding a real seller

Shopify's custom distribution installs an app on one store only, so each real
seller gets a Shopify app made for their store. You make it (about five
minutes); the seller only clicks a link.

What the seller does:

1. Opens the install link you send and approves the app in Shopify.
2. Lands on AI Ops sign-up with their store already named, picks a business
   name, email and password, and clicks **Create account and connect**. No
   invite code: Shopify's signed install stands in for it.
3. Is back in AI Ops with the store connected; orders and stock come in by
   themselves. From there they turn on alerts in Settings.

What you do, once per seller:

## 1. Get their store address

It ends in `.myshopify.com`. They can find it in their Shopify admin under
**Settings > Domains**, or from the admin's web address:
`admin.shopify.com/store/their-store` is `their-store.myshopify.com`.

## 2. Make the app

In the [Shopify Dev Dashboard](https://dev.shopify.com/dashboard), **Apps >
Create app > Start from Dev Dashboard**. Name it so you can tell them apart,
e.g. `AI Ops - Their Store`.

On its **Versions** page, the same settings as your first app (see
[deploy/README.md, step 6](../deploy/README.md#6-point-the-shopify-app-at-the-server)):

| Setting | Value |
|---|---|
| App URL | `https://ai-ops-drew.duckdns.org/api/shopify/install` |
| Allowed redirection URL | `https://ai-ops-drew.duckdns.org/api/shopify/callback` |
| Compliance webhooks (all three) | `https://ai-ops-drew.duckdns.org/api/webhooks/compliance` |
| Scopes | `read_orders`, `read_products`, `read_inventory`, `write_merchant_managed_fulfillment_orders` |

Then **Release**.

## 3. Pick custom distribution and get the link

On the app's **Home**, the **Distribution** card: **Select distribution
method > Custom distribution**. Enter their store address, then **Generate
link** and copy it.

This can't be changed later, which is why each seller has their own app.
Never do it on your first app: your dev stores use that one.

## 4. Give the app to the server

The app's **App settings > Credentials** has its **Client ID** and **Client
secret**. On the server:

```bash
cd ~/ai-ops-command-center/deploy
docker compose exec backend npm run store-app -- add their-store.myshopify.com
```

It asks for the client ID, then the secret (typed or pasted, not shown). The
secret is stored encrypted. `npm run store-app -- list` shows every store's
app and whether that store is connected yet.

## 5. Send them the link

Something like: "Here's the install link for AI Ops. Open it while signed in
to your Shopify admin, approve it, then create your account on the page it
opens. Your orders and stock come in by themselves."

## If something goes wrong

- **"This install link is invalid or has expired"** after they approve: the
  server doesn't have this store's app, or has a wrong secret. Check
  `store-app -- list`, and run step 4 again (it replaces what's there).
- **They already have an account** (they signed up before): the install link
  sends them straight to Shopify's approval, and the store connects to it.
- **A customer's name shows as "Name not shared"**: each app asks Shopify for
  protected customer data on its own. Until Shopify approves this app's
  request, names stay hidden; everything else works.
- **Removing a seller's app**: `store-app -- remove their-store.myshopify.com`
  (it refuses while the store is connected; `--force` removes it anyway, and
  the connection then stops working).
