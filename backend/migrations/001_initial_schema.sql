-- AI Ops Command Center: the database schema when versioned migrations
-- began. Multi-tenant: every table except sellers is scoped by seller_id.
--
-- Never edit a migration that has run somewhere: add a new numbered file
-- instead (npm run migrate:new -- <name>). See README, "Database migrations".

-- One row per seller account (a "tenant")
CREATE TABLE sellers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  shopify_shop_domain VARCHAR(255),     -- e.g. ai-ops.myshopify.com; kept after disconnecting
  shopify_access_token TEXT,            -- Admin API access token, encrypted (enc:v1:...); NULL = not connected
  shopify_refresh_token TEXT,           -- encrypted; only for expiring tokens from "Connect with Shopify"
  shopify_token_expires_at TIMESTAMP NULL,  -- NULL for tokens that don't expire (pasted custom-app tokens)
  shopify_scopes VARCHAR(500),          -- what the token was granted, e.g. read_orders,read_products
  slack_webhook_url TEXT,               -- this seller's Slack incoming webhook, encrypted
  alert_email VARCHAR(255),             -- confirmed address for email alerts
  telegram_chat_id VARCHAR(64),         -- linked Telegram chat for alerts
  orders_synced_at TIMESTAMP NULL,      -- start of the last order sync; the next asks Shopify for changes since
  default_low_stock_threshold INT NOT NULL DEFAULT 5,  -- what new items start with
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_shop_domain (shopify_shop_domain)  -- one account per store
);

-- Shopify's privacy (GDPR) webhooks as they arrive: ids and outcomes only,
-- never the personal data itself.
CREATE TABLE privacy_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NULL,
  topic VARCHAR(50) NOT NULL,               -- customers/data_request, customers/redact, shop/redact
  shop_domain VARCHAR(255),
  details JSON,                             -- order ids involved, what was redacted/deleted
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE SET NULL,
  INDEX idx_seller_topic (seller_id, topic)
);

-- Linking an alert channel: a 6-digit code emailed to the address, or the
-- one-time code in a Telegram bot link. Only the code's hash is stored.
CREATE TABLE channel_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  channel VARCHAR(20) NOT NULL,             -- email | telegram
  target VARCHAR(255),                      -- the address being confirmed (email only)
  code_hash CHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  INDEX idx_seller_channel (seller_id, channel),
  INDEX idx_code (code_hash)
);

-- "Connect with Shopify" in progress: the state sent to Shopify's approval
-- page, checked (once) when Shopify redirects back.
CREATE TABLE oauth_states (
  state CHAR(48) PRIMARY KEY,
  seller_id INT NOT NULL,
  shop VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE
);

-- Orders pulled in from Shopify, normalized to our own shape
CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  shopify_order_id VARCHAR(100) NOT NULL,   -- Shopify's own order ID
  order_number VARCHAR(50),                 -- human-friendly, e.g. #1001
  status VARCHAR(50) NOT NULL,              -- fulfillment_status: unfulfilled, fulfilled, partial
  financial_status VARCHAR(50),             -- pending, paid, refunded
  buyer_name VARCHAR(255),
  total_amount DECIMAL(10,2),
  order_placed_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id),
  UNIQUE KEY uniq_seller_order (seller_id, shopify_order_id)
);

-- Inventory snapshot, so "low stock" tool has something to check
CREATE TABLE inventory_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  shopify_product_id VARCHAR(100) NOT NULL,
  shopify_variant_id VARCHAR(100),
  shopify_inventory_item_id VARCHAR(100),   -- what inventory_levels/update webhooks refer to
  item_name VARCHAR(255),
  stock_quantity INT DEFAULT 0,
  low_stock_threshold INT DEFAULT 5,        -- set per item by the seller; new items get the seller's default
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id),
  UNIQUE KEY uniq_seller_variant (seller_id, shopify_variant_id),
  INDEX idx_seller_inventory_item (seller_id, shopify_inventory_item_id)
);

-- Customer messages/complaints, for the "summarize complaints" and "draft reply" tools
-- (Shopify has no built-in messaging API for most stores, so this stays manual/n8n-fed for now)
CREATE TABLE customer_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  buyer_name VARCHAR(255),
  message_text TEXT,
  is_resolved BOOLEAN DEFAULT FALSE,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id)
);

-- Long-lived API keys for tools (e.g. the MCP server in Claude Desktop).
-- Only a SHA-256 hash is stored; the key is shown once when it's created.
CREATE TABLE api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,          -- first characters, to tell keys apart in the UI
  key_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NULL,
  revoked_at TIMESTAMP NULL,
  FOREIGN KEY (seller_id) REFERENCES sellers(id),
  UNIQUE KEY uniq_key_hash (key_hash)
);

-- Every decision the agent makes, for the dashboard.
-- action_taken is what the agent *recommended* (it doesn't act on Shopify yet):
-- fulfill, hold, low_stock_alert, unknown if its verdict couldn't be parsed,
-- or skipped when a daily limit stopped the run (see agent_runs).
CREATE TABLE decisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  order_id INT NULL,                        -- our orders.id; NULL for low-stock decisions
  order_number VARCHAR(50),                 -- kept even if the order row is later deleted
  reasoning TEXT NOT NULL,                  -- the agent's full output
  action_taken VARCHAR(32) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL,
  INDEX idx_seller_created (seller_id, created_at)
);

-- One row per agent run that went ahead (called the LLM). The daily limits
-- per account and in total count these over the last 24 hours.
CREATE TABLE agent_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  seller_id INT NOT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  INDEX idx_seller_started (seller_id, started_at),
  INDEX idx_started (started_at)
);

-- Background work that has to survive a restart: agent runs and stock
-- re-reads from webhooks (src/services/jobQueue.js). Payloads never hold
-- customer details. Finished jobs are pruned after 30 days.
CREATE TABLE jobs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(50) NOT NULL,                -- agent_run, refresh_inventory_item
  seller_id INT NOT NULL,
  payload JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued, running, done, failed
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  run_after TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- a retry waits until then
  locked_at TIMESTAMP NULL,
  last_error TEXT,
  dedupe_key VARCHAR(191) NULL,             -- e.g. one agent run per order; NULL = no check
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_dedupe (dedupe_key),
  INDEX idx_claim (status, run_after)
);

-- Shopify webhook deliveries already handled (X-Shopify-Webhook-Id), so a
-- redelivery is recognised even after a restart. Pruned after 7 days.
CREATE TABLE webhook_deliveries (
  webhook_id VARCHAR(255) PRIMARY KEY,
  topic VARCHAR(50) NOT NULL,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_received (received_at)
);
