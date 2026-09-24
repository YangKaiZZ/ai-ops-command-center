// Shapes returned by the backend API.

export type Order = {
  id: number;
  order_number: string | null;
  status: string; // Shopify fulfillment status: unfulfilled, partial, fulfilled
  financial_status: string | null; // paid, pending, refunded, ...
  buyer_name: string | null;
  total_amount: string | null; // DECIMAL comes back as a string
  order_placed_at: string | null;
};

export type LowStockItem = {
  id: number;
  item_name: string;
  shopify_variant_id: string;
  stock_quantity: number;
  low_stock_threshold: number;
};

export type Action = "fulfill" | "hold" | "low_stock_alert" | "unknown";

export type Decision = {
  id: number;
  order_id: number | null;
  order_number: string | null;
  action_taken: Action;
  reasoning: string;
  created_at: string;
};

export type Session = { token: string; business_name?: string };

// GET /api/settings: whether things are set up, never the secrets themselves.
export type Settings = {
  business_name: string;
  email: string;
  store: { connected: boolean; shop_domain: string | null };
  slack: { connected: boolean };
};

export type ApiKey = {
  id: number;
  name: string;
  key_prefix: string; // first characters, e.g. "aiops_Ab12Cd"
  created_at: string;
  last_used_at: string | null;
};
