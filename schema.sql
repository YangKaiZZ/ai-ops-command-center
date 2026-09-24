-- AI Ops Command Center — Database Schema
-- Multi-tenant: every table (except sellers/users) is scoped by seller_id

CREATE DATABASE IF NOT EXISTS ai_ops;
USE ai_ops;

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

-- Every decision the Phase 4 agent makes, for the dashboard.
-- action_taken is what the agent *recommended* (it doesn't act on Shopify yet):
-- fulfill, hold, low_stock_alert, or unknown if its verdict couldn't be parsed.
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
