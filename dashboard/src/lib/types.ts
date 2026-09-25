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

// GET /api/orders/:id
export type LineItem = {
  shopify_line_item_id: string;
  shopify_variant_id: string | null;
  title: string;
  variant_title: string | null;
  sku: string | null;
  quantity: number;
  fulfillable_quantity: number | null; // still to ship
  price: string | null; // per unit
};

export type OrderDetail = {
  order: Omit<Order, "latest_decision"> & { shopify_order_id: string; synced_at: string | null };
  line_items: LineItem[] | null; // null: not available, and line_items_note says why
  line_items_note: string | null;
  decisions: Pick<Decision, "id" | "action_taken" | "reasoning" | "created_at" | "feedback" | "feedback_note" | "feedback_at">[];
  shopify_admin_url: string | null;
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

// GET /api/inventory/forecast: one tracked item's pace and restock need.
export type ItemForecast = {
  id: number; // same id as the InventoryItem
  item_name: string;
  stock_quantity: number;
  units_sold: number; // over the history below
  orders: number;
  per_day: number;
  days_left: number | null; // 0: out of stock; null: not selling, so no run-out date
  runs_out_at: string | null;
  reorder_quantity: number; // enough to last cover_days; 0 = none needed
  confidence: "low" | "normal"; // low: under 3 orders or under 7 days of history
};

export type ForecastHistory = {
  from: string | null; // null: the store has no orders yet
  days: number;
  orders: number; // orders counted
  orders_missing_items: number; // in that stretch, but their items aren't stored yet
};

export type Forecast = {
  lookback_days: number;
  cover_days: number;
  history: ForecastHistory;
  items: ItemForecast[]; // soonest to run out first
};

// GET /api/overview: this period's key numbers next to the same length of time before it.
export type Overview = {
  period: { from: string; to: string; days: number };
  orders: {
    count: number; // every order placed
    previous_count: number;
    sales: string; // order totals, refunded and voided left out (DECIMAL as a string)
    previous_sales: string;
    needs_action: number;
    oldest_unshipped: { id: number; order_number: string | null; order_placed_at: string } | null;
  };
  stock: {
    tracked: number;
    low: number; // at or below the item's level, out of stock included
    out_of_stock: number;
    to_reorder: number;
    running_out_within_days: number;
    running_out: ItemForecast[]; // still in stock, but run out within running_out_within_days
    forecast: { lookback_days: number; cover_days: number; history: ForecastHistory };
  };
  decisions: Record<Action, number> & { total: number; ratings: Ratings }; // ratings: of this period's decisions
};

// "skipped": a daily limit stopped the agent before it ran.
export type Action = "fulfill" | "hold" | "low_stock_alert" | "unknown" | "skipped";

// The seller's rating of a decision: up = the right call, down = the wrong one.
export type Feedback = "up" | "down";

export type Decision = {
  id: number;
  order_id: number | null;
  order_number: string | null;
  action_taken: Action;
  reasoning: string;
  created_at: string;
  feedback: Feedback | null;
  feedback_note: string | null;
  feedback_at: string | null;
};

// PUT /api/decisions/:id/feedback
export type SavedFeedback = Pick<Decision, "id" | "feedback" | "feedback_note" | "feedback_at">;

// How decisions have been rated. Skipped runs can't be rated, so they're not in `unrated`.
export type RatingCounts = { up: number; down: number; unrated: number };
export type Ratings = RatingCounts & { by_verdict: Record<Exclude<Action, "skipped">, RatingCounts> };

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
