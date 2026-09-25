-- order risk
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- Shopify's fraud analysis of each order (services/riskCheck.js), NULL until
-- it's been read. What the agent and the dashboard use, and no addresses:
-- only whether the billing address matches the shipping address.
ALTER TABLE orders
  ADD COLUMN risk_level VARCHAR(10) NULL,             -- high, medium, low, none (no rating) or pending
  ADD COLUMN risk_recommendation VARCHAR(12) NULL,    -- Shopify's advice: accept, investigate, cancel or none
  ADD COLUMN risk_reasons JSON NULL,                  -- the facts that raised the risk, as Shopify words them
  ADD COLUMN billing_matches_shipping BOOLEAN NULL,   -- NULL when nothing in the order ships
  ADD COLUMN risk_checked_at TIMESTAMP NULL,
  ADD COLUMN risk_alerted_at TIMESTAMP NULL;          -- when a "fraud risk went up" alert named this order
