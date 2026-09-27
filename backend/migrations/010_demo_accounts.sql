-- demo accounts
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- "Try the demo" (services/demo.js): each visitor gets their own account with
-- a sample store, no password and no real Shopify store behind it, removed
-- once demo_expires_at has passed.
ALTER TABLE sellers
  ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN demo_expires_at TIMESTAMP NULL,
  ADD INDEX idx_demo_expires (is_demo, demo_expires_at);
