-- orders placed index
-- Runs once per database, after every lower-numbered migration. Once it has
-- run anywhere, don't edit it: add another migration instead.

-- Order lists are paged newest first (GET /api/orders?limit=&offset=), so
-- each page is read in index order instead of sorting every order the seller has.
CREATE INDEX idx_seller_placed ON orders (seller_id, order_placed_at, id);
