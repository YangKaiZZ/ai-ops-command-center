// Shapes returned by the backend API.

export type Order = {
  id: number;
  order_number: string | null;
  status: string; // Shopify fulfillment status: unfulfilled, partial, fulfilled
  financial_status: string | null; // paid, pending, refunded, ...
  buyer_name: string | null;
  total_amount: string | null; // DECIMAL comes back as a string
  order_placed_at: string | null;
  latest_decision: { action_taken: Action; created_at: string } | null; // the agent's most recent verdict
};

// GET /api/orders: one page, and how many orders there are in all.
export type OrdersPage = { orders: Order[]; total: number; limit: number; offset: number };

// GET /api/inventory: every tracked item; low = at or below its threshold.
export type InventoryItem = {
  id: number;
  item_name: string;
  shopify_variant_id: string;
  stock_quantity: number;
  low_stock_threshold: number;
  is_low: boolean;
};

// "skipped": a daily limit stopped the agent before it ran.
export type Action = "fulfill" | "hold" | "low_stock_alert" | "unknown" | "skipped";

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
  email: string; // the account's sign-in address
  store: { connected: boolean; shop_domain: string | null; missing_scopes: string[] };
  shopify: { oauth_available: boolean }; // "Connect with Shopify" is set up on the server
  inventory: { default_low_stock_threshold: number };
  slack: { connected: boolean };
  email_alerts: { available: boolean; address: string | null; pending: string | null };
  telegram: { available: boolean; connected: boolean };
};

export type AlertResult = { channel: "slack" | "email" | "telegram"; ok: boolean; error?: string };

export type ApiKey = {
  id: number;
  name: string;
  key_prefix: string; // first characters, e.g. "aiops_Ab12Cd"
  created_at: string;
  last_used_at: string | null;
};
