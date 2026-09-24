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
  shopify_shop_domain VARCHAR(255),     -- e.g. ai-ops.myshopify.com
  shopify_access_token TEXT,            -- Admin API access token (encrypt in prod)
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  item_name VARCHAR(255),
  stock_quantity INT DEFAULT 0,
  low_stock_threshold INT DEFAULT 5,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id),
  UNIQUE KEY uniq_seller_variant (seller_id, shopify_variant_id)
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
