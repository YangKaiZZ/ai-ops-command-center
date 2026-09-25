"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { SetupChecklist } from "@/components/SetupChecklist";
import { actionInfo, formatMoney, riskBadge, riskSummary, riskWorthShowing } from "@/lib/format";
import {
  filtersUrl,
  hasFilters,
  NO_FILTERS,
  ordersApiQuery,
  PAYMENT_OPTIONS,
  readFilters,
  SHIPPING_OPTIONS,
  type OrderFilters,
} from "@/lib/orderFilters";
import type { OrdersPage } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 300;
const pageButton =
  "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const fieldClass =
  "rounded-lg border border-hairline bg-page px-2.5 py-1.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full border border-border bg-ink/5 px-2 text-xs text-ink-2">{children}</span>
  );
}

// Search, the two statuses, a date range, "needs action" and fraud risk. Every change
// goes to the URL (back to page 1); typing in the search box waits for a pause.
function FilterBar({ filters, apply }: { filters: OrderFilters; apply: (f: OrderFilters) => void }) {
  const [text, setText] = useState(filters.q);
  // The search the URL had when `text` was last taken from it or sent to it. When
  // the URL changes some other way (Clear, back button), the box follows it.
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (filters.q !== syncedQ) {
    setSyncedQ(filters.q);
    setText(filters.q);
  }

  useEffect(() => {
    const q = text.trim();
    if (q === filters.q) return;
    const timer = setTimeout(() => {
      setSyncedQ(q);
      apply({ ...filters, q });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, filters, apply]);

  const set = (change: Partial<OrderFilters>) => apply({ ...filters, q: text.trim(), ...change });

  return (
    <form
      role="search"
      aria-label="Filter orders"
      className="mb-3 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        set({});
      }}
    >
      <input
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={100}
        placeholder="Order number or customer"
        aria-label="Search by order number or customer"
        className={`${fieldClass} min-w-[12rem] flex-1`}
      />
      <select aria-label="Shipping status" value={filters.status} onChange={(e) => set({ status: e.target.value })} className={fieldClass}>
        <option value="">Any shipping</option>
        {SHIPPING_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select aria-label="Payment status" value={filters.payment} onChange={(e) => set({ payment: e.target.value })} className={fieldClass}>
        <option value="">Any payment</option>
        {PAYMENT_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 text-sm text-ink-2">
        From
        <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} className={fieldClass} />
      </label>
      <label className="flex items-center gap-1.5 text-sm text-ink-2">
        To
        <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} className={fieldClass} />
      </label>
      <label className="flex items-center gap-1.5 py-1.5 text-sm">
        <input type="checkbox" checked={filters.needsAction} onChange={(e) => set({ needsAction: e.target.checked })} className="size-4 accent-accent" />
        Needs action
      </label>
      <label className="flex items-center gap-1.5 py-1.5 text-sm">
        <input type="checkbox" checked={filters.flagged} onChange={(e) => set({ flagged: e.target.checked })} className="size-4 accent-accent" />
        Flagged for fraud
      </label>
      {hasFilters(filters) && (
        <button type="button" onClick={() => apply(NO_FILTERS)} className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-accent hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          Clear filters
        </button>
      )}
    </form>
  );
}

// Previous / next, as links so the page is in the URL (reload and back keep it).
function Pager({ page, total, filters }: { page: number; total: number; filters: OrderFilters }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  const noun = hasFilters(filters) ? "matching orders" : "orders";
  return (
    <nav aria-label="Order pages" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-ink-2" aria-live="polite">
        {first <= total ? `${first}–${last} of ${total} ${noun}` : `${total} ${noun}`}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={filtersUrl(filters, page - 1)} className={pageButton}>
              Previous
            </Link>
          ) : (
            <span className={`${pageButton} cursor-not-allowed opacity-50`} aria-disabled="true">
              Previous
            </span>
          )}
          <span className="text-ink-2">
            Page {Math.min(page, pages)} of {pages}
          </span>
          {page < pages ? (
            <Link href={filtersUrl(filters, page + 1)} className={pageButton}>
              Next
            </Link>
          ) : (
            <span className={`${pageButton} cursor-not-allowed opacity-50`} aria-disabled="true">
              Next
            </span>
          )}
        </div>
      )}
    </nav>
  );
}

function OrdersList() {
  const { data, updatedAt } = useDashboard();
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramsKey = searchParams.toString();
  const filters = useMemo(() => readFilters(new URLSearchParams(paramsKey)), [paramsKey]);
  const page = Math.max(1, Math.floor(Number(searchParams.get("page"))) || 1);
  const query = ordersApiQuery(filters, page, PAGE_SIZE);
  const [result, setResult] = useState<(OrdersPage & { query: string }) | null>(null);
  const [error, setError] = useState("");

  const apply = useCallback((f: OrderFilters) => router.replace(filtersUrl(f), { scroll: false }), [router]);

  // This view's orders; loaded again whenever the dashboard refreshes (poll or sync).
  useEffect(() => {
    let cancelled = false;
    api<OrdersPage>(`/api/orders?${query}`)
      .then((body) => {
        if (cancelled) return;
        setResult({ ...body, query });
        setError("");
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Couldn't load orders: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [api, query, updatedAt]);

  if (!data || (!result && !error)) return <Empty>Loading orders…</Empty>;

  const filtered = hasFilters(filters);
  // A store with no orders at all gets the setup messages, not an empty filter bar.
  if (result && result.total === 0 && !filtered) {
    return data.settings.store.connected ? (
      <Empty>No orders synced yet. Use “Sync from Shopify”.</Empty>
    ) : (
      <Empty>
        Connect your store in{" "}
        <Link href="/settings" className="text-accent underline">
          Settings
        </Link>{" "}
        to see your orders here.
      </Empty>
    );
  }

  const stale = result !== null && result.query !== query; // the previous view, until this one arrives
  const listUrl = filtersUrl(filters, page);
  const detailHref = (id: number) => (listUrl === "/orders" ? `/orders/${id}` : `/orders/${id}?back=${encodeURIComponent(listUrl)}`);
  let body: React.ReactNode;
  if (!result) {
    body = null;
  } else if (!stale && result.total === 0) {
    body = (
      <Empty>
        No orders match these filters.{" "}
        <button type="button" onClick={() => apply(NO_FILTERS)} className="text-accent underline">
          Clear filters
        </button>
      </Empty>
    );
  } else if (!stale && result.orders.length === 0) {
    body = (
      <Empty>
        There&rsquo;s no page {page}.{" "}
        <Link href={filtersUrl(filters)} className="text-accent underline">
          Back to the first page
        </Link>
      </Empty>
    );
  } else {
    body = (
      <>
        <div className="overflow-x-auto" aria-busy={stale}>
          <table className={`w-full border-collapse text-sm ${stale ? "opacity-60" : ""}`}>
            <thead>
              <tr className="border-b border-hairline text-left font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Order</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Customer</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3 text-right">Total</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Shipping</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Payment</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Placed</th>
                <th scope="col" className="whitespace-nowrap pb-2">Agent verdict</th>
              </tr>
            </thead>
            <tbody>
              {result.orders.map((order) => {
                const action = order.latest_decision && actionInfo(order.latest_decision.action_taken);
                const placed = order.order_placed_at ? new Date(order.order_placed_at) : null;
                const risk = riskWorthShowing(order.risk) ? order.risk : null;
                return (
                  <tr key={order.id} className="border-b border-hairline transition-colors last:border-0 hover:bg-ink/[0.03]" data-order={order.order_number ?? ""}>
                    <td className="py-2.5 pr-3 font-semibold">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Link href={detailHref(order.id)} className="text-accent hover:underline focus-visible:underline">
                          {order.order_number ?? `Order ${order.id}`}
                        </Link>
                        {risk && (
                          <span title={[riskSummary(risk), ...risk.reasons].join("\n")}>
                            <Badge {...riskBadge(risk)} />
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">{order.buyer_name || "Guest"}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{formatMoney(order.total_amount)}</td>
                    <td className="py-2.5 pr-3"><Chip>{order.status || "—"}</Chip></td>
                    <td className="py-2.5 pr-3"><Chip>{order.financial_status || "—"}</Chip></td>
                    <td className="whitespace-nowrap py-2.5 pr-3 tabular-nums" title={placed?.toLocaleString()}>
                      {placed ? placed.toLocaleDateString() : "—"}
                    </td>
                    <td className="py-2.5">
                      {action ? (
                        <Badge label={action.label} tone={action.tone} icon={action.icon} />
                      ) : (
                        <span className="text-sm text-ink-2">No decision</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!stale && <Pager page={page} total={result.total} filters={filters} />}
      </>
    );
  }

  return (
    <>
      <FilterBar filters={filters} apply={apply} />
      {error && (
        <p role="alert" className="mb-2 text-sm text-error">
          {error}
        </p>
      )}
      {body}
    </>
  );
}

export default function OrdersPage() {
  const { data } = useDashboard();

  return (
    <div className="grid gap-4">
      {data && <SetupChecklist settings={data.settings} />}
      <Panel title="Orders">
        {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
        <Suspense fallback={<Empty>Loading orders…</Empty>}>
          <OrdersList />
        </Suspense>
      </Panel>
    </div>
  );
}
