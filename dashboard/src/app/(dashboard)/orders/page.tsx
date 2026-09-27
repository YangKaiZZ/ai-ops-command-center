"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { BuyerName } from "@/components/BuyerName";
import { useDashboard } from "@/components/DashboardProvider";
import { MagnifyingGlassIcon } from "@/components/icons";
import { card, Empty } from "@/components/Panel";
import { SetupChecklist } from "@/components/SetupChecklist";
import { eyebrow, fieldClass, focusRing, PageHeader, secondaryButton, small, Tabs, type TabItem } from "@/components/ui";
import { actionInfo, formatMoney, fulfillmentBadge, paymentBadge, riskBadge, riskSummary } from "@/lib/format";
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

// The tabs are presets of the filters: each keeps the search, payment and
// dates, and sets the rest.
type View = "all" | "needs" | "flagged" | "fulfilled";
const VIEWS: { key: View; label: string; set: Pick<OrderFilters, "needsAction" | "flagged" | "status"> }[] = [
  { key: "all", label: "All", set: { needsAction: false, flagged: false, status: "" } },
  { key: "needs", label: "Needs action", set: { needsAction: true, flagged: false, status: "" } },
  { key: "flagged", label: "Flagged for fraud", set: { needsAction: false, flagged: true, status: "" } },
  { key: "fulfilled", label: "Fulfilled", set: { needsAction: false, flagged: false, status: "fulfilled" } },
];

// Which tab the filters are, or null for a mix no tab matches.
function viewOf(f: OrderFilters): View | null {
  const match = VIEWS.find((v) => v.set.needsAction === f.needsAction && v.set.flagged === f.flagged && v.set.status === f.status);
  return match?.key ?? null;
}

// Search, payment, shipping and a date range. Every change goes to the URL
// (back to page 1); typing in the search box waits for a pause.
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
      className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3 sm:px-[18px]"
      onSubmit={(event) => {
        event.preventDefault();
        set({});
      }}
    >
      <span className={`${fieldClass} flex min-w-[12rem] flex-1 items-center gap-2 focus-within:border-accent/50`}>
        <MagnifyingGlassIcon aria-hidden="true" className="size-[15px] shrink-0 text-ink-2" />
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={100}
          placeholder="Order number or customer"
          aria-label="Search by order number or customer"
          className="min-w-0 flex-1 bg-transparent placeholder:text-ink-2 focus:outline-none"
        />
      </span>
      <select aria-label="Payment status" value={filters.payment} onChange={(e) => set({ payment: e.target.value })} className={fieldClass}>
        <option value="">Any payment</option>
        {PAYMENT_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <select aria-label="Shipping status" value={filters.status} onChange={(e) => set({ status: e.target.value })} className={fieldClass}>
        <option value="">Any shipping</option>
        {SHIPPING_OPTIONS.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
        From
        <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} className={fieldClass} />
      </label>
      <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
        To
        <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} className={fieldClass} />
      </label>
      {hasFilters(filters) && (
        <button type="button" onClick={() => apply(NO_FILTERS)} className={`rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-accent hover:bg-ink/5 ${focusRing}`}>
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
  const button = `${secondaryButton} ${small}`;
  return (
    <nav aria-label="Order pages" className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline px-4 py-3 text-[12.5px] sm:px-[18px]">
      <span className="text-ink-2" aria-live="polite">
        {first <= total ? `Showing ${first}–${last} of ${total} ${noun}` : `${total} ${noun}`}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={filtersUrl(filters, page - 1)} className={button}>
              Previous
            </Link>
          ) : (
            <span className={`${button} cursor-not-allowed opacity-50`} aria-disabled="true">
              Previous
            </span>
          )}
          <span className="text-ink-2">
            Page {Math.min(page, pages)} of {pages}
          </span>
          {page < pages ? (
            <Link href={filtersUrl(filters, page + 1)} className={button}>
              Next
            </Link>
          ) : (
            <span className={`${button} cursor-not-allowed opacity-50`} aria-disabled="true">
              Next
            </span>
          )}
        </div>
      )}
    </nav>
  );
}

const th = `${eyebrow} whitespace-nowrap px-3 py-3 text-left first:pl-4 last:pr-4 sm:first:pl-[18px] sm:last:pr-[18px]`;
const td = "whitespace-nowrap px-3 py-3.5 first:pl-4 last:pr-4 sm:first:pl-[18px] sm:last:pr-[18px]";

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
  const [counts, setCounts] = useState<Partial<Record<View, number>>>({});
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

  // Each tab's count, with the same search, payment and dates.
  const countsKey = JSON.stringify({ q: filters.q, payment: filters.payment, from: filters.from, to: filters.to });
  useEffect(() => {
    let cancelled = false;
    const base = JSON.parse(countsKey) as Pick<OrderFilters, "q" | "payment" | "from" | "to">;
    Promise.all(
      VIEWS.map((v) => api<OrdersPage>(`/api/orders?${ordersApiQuery({ ...NO_FILTERS, ...base, ...v.set }, 1, 1)}`).then((body) => [v.key, body.total] as const))
    )
      .then((pairs) => {
        if (!cancelled) setCounts(Object.fromEntries(pairs));
      })
      .catch(() => {}); // the list shows any error; the tabs just go without counts
    return () => {
      cancelled = true;
    };
  }, [api, countsKey, updatedAt]);

  if (!data || (!result && !error)) return <Empty>Loading orders…</Empty>;

  const filtered = hasFilters(filters);
  // A store with no orders at all gets the setup messages, not an empty filter bar.
  if (result && result.total === 0 && !filtered) {
    return (
      <div className={`${card} px-5 py-4`}>
        {data.settings.store.connected ? (
          <Empty>No orders synced yet. Use “Sync now” at the top.</Empty>
        ) : (
          <Empty>
            Connect your store in{" "}
            <Link href="/settings" className="text-accent underline">
              Settings
            </Link>{" "}
            to see your orders here.
          </Empty>
        )}
      </div>
    );
  }

  const tabs: TabItem<View>[] = VIEWS.map((v) => ({
    key: v.key,
    label: v.label,
    count: counts[v.key] ?? null,
    href: filtersUrl({ ...filters, ...v.set }),
  }));

  const stale = result !== null && result.query !== query; // the previous view, until this one arrives
  const listUrl = filtersUrl(filters, page);
  const detailHref = (id: number) => (listUrl === "/orders" ? `/orders/${id}` : `/orders/${id}?back=${encodeURIComponent(listUrl)}`);
  let body: React.ReactNode;
  if (!result) {
    body = null;
  } else if (!stale && result.total === 0) {
    body = (
      <div className="px-4 py-3 sm:px-[18px]">
        <Empty>
          No orders match these filters.{" "}
          <button type="button" onClick={() => apply(NO_FILTERS)} className="text-accent underline">
            Clear filters
          </button>
        </Empty>
      </div>
    );
  } else if (!stale && result.orders.length === 0) {
    body = (
      <div className="px-4 py-3 sm:px-[18px]">
        <Empty>
          There&rsquo;s no page {page}.{" "}
          <Link href={filtersUrl(filters)} className="text-accent underline">
            Back to the first page
          </Link>
        </Empty>
      </div>
    );
  } else {
    body = (
      <>
        <div className="overflow-x-auto" aria-busy={stale}>
          <table className={`w-full border-collapse text-[13.5px] ${stale ? "opacity-60" : ""}`}>
            <thead>
              <tr>
                <th scope="col" className={th}>Order</th>
                <th scope="col" className={th}>Customer</th>
                <th scope="col" className={`${th} text-right`}>Total</th>
                <th scope="col" className={th}>Payment</th>
                <th scope="col" className={th}>Fulfillment</th>
                <th scope="col" className={th}>Agent</th>
                <th scope="col" className={th}>Fraud risk</th>
                <th scope="col" className={th}>Placed</th>
              </tr>
            </thead>
            <tbody>
              {result.orders.map((order) => {
                const action = order.latest_decision && actionInfo(order.latest_decision.action_taken);
                const placed = order.order_placed_at ? new Date(order.order_placed_at) : null;
                const risk = order.risk;
                const href = detailHref(order.id);
                return (
                  <tr
                    key={order.id}
                    onClick={(event) => {
                      // The whole row opens the order; the link in it is there for keyboards.
                      if (!(event.target as HTMLElement).closest("a")) router.push(href);
                    }}
                    className={`cursor-pointer border-t border-hairline transition-colors hover:bg-line ${risk?.flagged ? "bg-critical/[0.04]" : ""}`}
                    data-order={order.order_number ?? ""}
                  >
                    <td className={`${td} font-mono font-semibold`}>
                      <Link href={href} className={`hover:text-accent ${focusRing}`}>
                        {order.order_number ?? `Order ${order.id}`}
                      </Link>
                    </td>
                    <td className={td}>
                      <BuyerName name={order.buyer_name} />
                    </td>
                    <td className={`${td} text-right font-mono`}>{formatMoney(order.total_amount)}</td>
                    <td className={td}>
                      <Badge {...paymentBadge(order.financial_status)} />
                    </td>
                    <td className={td}>
                      <Badge {...fulfillmentBadge(order.status)} />
                    </td>
                    <td className={td}>
                      {action ? <Badge label={action.label} tone={action.tone} /> : <span className="text-[12.5px] text-ink-2">No call</span>}
                    </td>
                    <td className={td}>
                      {risk ? (
                        <span title={[riskSummary(risk), ...risk.reasons].join("\n")}>
                          <Badge label={riskBadge(risk).label} tone={risk.flagged || risk.level === "pending" ? riskBadge(risk).tone : "neutral"} />
                        </span>
                      ) : (
                        <span className="text-ink-2">—</span>
                      )}
                    </td>
                    <td className={`${td} text-[12.5px] text-ink-2`} title={placed?.toLocaleString()}>
                      {placed ? placed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: placed.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "—"}
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
      <Tabs label="Order views" tabs={tabs} active={viewOf(filters)} />
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <section className={`${card} overflow-hidden`}>
        <FilterBar filters={filters} apply={apply} />
        {body}
      </section>
    </>
  );
}

export default function OrdersPage() {
  const { data } = useDashboard();

  return (
    <>
      <PageHeader title="Orders" sub="Every order from your store, with the agent's call on each" />
      {data && <SetupChecklist settings={data.settings} />}
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense fallback={<Empty>Loading orders…</Empty>}>
        <OrdersList />
      </Suspense>
    </>
  );
}
