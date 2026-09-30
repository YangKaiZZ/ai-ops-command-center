-- store apps
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- A Shopify app of a store's own. Custom distribution installs an app on one
-- store only, so each real seller gets an app made for their store; its
-- client ID and secret live here (the secret encrypted, like store tokens),
-- keyed by the store it's for. Stores without a row use the server's app
-- (SHOPIFY_API_KEY / SHOPIFY_API_SECRET). Added with `npm run store-app`.
CREATE TABLE store_apps (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shop_domain VARCHAR(255) NOT NULL,
  client_id VARCHAR(255) NOT NULL,
  client_secret TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_store_app_shop (shop_domain)
);
