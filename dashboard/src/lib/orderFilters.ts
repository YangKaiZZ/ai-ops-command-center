// The Orders page's search and filters, kept in the URL (?q=&status=&payment=&from=&to=&needs_action=1&page=)
// so a filtered view survives reloads and can be shared.

export type OrderFilters = {
  q: string;
  status: string; // fulfillment status, "" for any
  payment: string; // financial status, "" for any
  from: string; // YYYY-MM-DD in the seller's own time zone, "" for open
  to: string;
  needsAction: boolean;
};

export const SHIPPING_OPTIONS: [string, string][] = [
  ["unfulfilled", "Unfulfilled"],
  ["partial", "Partly shipped"],
  ["fulfilled", "Fulfilled"],
  ["restocked", "Restocked"],
];

export const PAYMENT_OPTIONS: [string, string][] = [
  ["paid", "Paid"],
  ["pending", "Pending"],
  ["authorized", "Authorized"],
  ["partially_paid", "Partly paid"],
  ["partially_refunded", "Partly refunded"],
  ["refunded", "Refunded"],
  ["voided", "Voided"],
  ["expired", "Expired"],
];

export const NO_FILTERS: OrderFilters = { q: "", status: "", payment: "", from: "", to: "", needsAction: false };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isOption = (options: [string, string][], value: string | null) => options.some(([v]) => v === value);

// Anything unrecognised in the URL is ignored rather than sent to the API.
export function readFilters(params: URLSearchParams): OrderFilters {
  const status = params.get("status");
  const payment = params.get("payment");
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  return {
    q: (params.get("q") ?? "").trim().slice(0, 100),
    status: isOption(SHIPPING_OPTIONS, status) ? status! : "",
    payment: isOption(PAYMENT_OPTIONS, payment) ? payment! : "",
    from: DAY.test(from) ? from : "",
    to: DAY.test(to) ? to : "",
    needsAction: params.get("needs_action") === "1",
  };
}

export function hasFilters(f: OrderFilters): boolean {
  return Boolean(f.q || f.status || f.payment || f.from || f.to || f.needsAction);
}

export function filtersUrl(f: OrderFilters, page = 1): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.status) params.set("status", f.status);
  if (f.payment) params.set("payment", f.payment);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.needsAction) params.set("needs_action", "1");
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/orders?${query}` : "/orders";
}

// A day in the seller's time zone as the instant it starts, or (for `to`) the
// last millisecond of it, so "placed on the 3rd" matches the dates they see.
function localDayBoundary(day: string, end: boolean): string {
  const [y, m, d] = day.split("-").map(Number);
  return (end ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)).toISOString();
}

// Where "Back to orders" goes: the list view the seller came from (passed as
// ?back=), if it really is an Orders list URL; otherwise the plain list.
export function backToList(back: string | null): string {
  return back && /^\/orders(\?[^#]*)?$/.test(back) ? back : "/orders";
}

// The GET /api/orders query for one page.
export function ordersApiQuery(f: OrderFilters, page: number, pageSize: number): string {
  const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) });
  if (f.q) params.set("q", f.q);
  if (f.status) params.set("status", f.status);
  if (f.payment) params.set("financial_status", f.payment);
  if (f.from) params.set("from", localDayBoundary(f.from, false));
  if (f.to) params.set("to", localDayBoundary(f.to, true));
  if (f.needsAction) params.set("needs_action", "true");
  return params.toString();
}
