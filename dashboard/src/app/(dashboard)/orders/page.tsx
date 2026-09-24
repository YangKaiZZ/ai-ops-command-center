"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { SetupChecklist } from "@/components/SetupChecklist";
import { actionInfo, formatMoney } from "@/lib/format";
import type { OrdersPage } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const PAGE_SIZE = 50;
const pageButton =
  "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full border border-hairline px-2 text-xs text-ink-2">{children}</span>
  );
}

const pageHref = (page: number) => (page <= 1 ? "/orders" : `/orders?page=${page}`);

// Previous / next, as links so the page is in the URL (reload and back keep it).
function Pager({ page, total }: { page: number; total: number }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const first = (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  return (
    <nav aria-label="Order pages" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-ink-2" aria-live="polite">
        {first <= total ? `${first}–${last} of ${total}` : `${total} orders`}
      </span>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className={pageButton}>
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
            <Link href={pageHref(page + 1)} className={pageButton}>
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
  const page = Math.max(1, Math.floor(Number(useSearchParams().get("page"))) || 1);
  const [result, setResult] = useState<(OrdersPage & { page: number }) | null>(null);
  const [error, setError] = useState("");

  // This page's orders; loaded again whenever the dashboard refreshes (poll or sync).
  useEffect(() => {
    let cancelled = false;
    api<OrdersPage>(`/api/orders?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`)
      .then((body) => {
        if (cancelled) return;
        setResult({ ...body, page });
        setError("");
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Couldn't load orders: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [api, page, updatedAt]);

  if (error && !result) return <Empty>{error}</Empty>;
  if (!data || !result) return <Empty>Loading orders…</Empty>;
  if (result.total === 0) {
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
  if (result.orders.length === 0 && result.page === page) {
    return (
      <Empty>
        There&rsquo;s no page {page}.{" "}
        <Link href="/orders" className="text-accent underline">
          Back to the newest orders
        </Link>
      </Empty>
    );
  }

  const stale = result.page !== page; // the previous page, until this one arrives
  return (
    <>
      {error && (
        <p role="alert" className="mb-2 text-sm text-error">
          {error}
        </p>
      )}
      <div className="overflow-x-auto" aria-busy={stale}>
        <table className={`w-full border-collapse text-sm ${stale ? "opacity-60" : ""}`}>
          <thead>
            <tr className="border-b border-hairline text-left text-xs font-semibold text-ink-2">
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
              return (
                <tr key={order.id} className="border-b border-hairline last:border-0" data-order={order.order_number ?? ""}>
                  <td className="py-2.5 pr-3 font-semibold">{order.order_number ?? "—"}</td>
                  <td className="py-2.5 pr-3">{order.buyer_name || "Guest"}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">{formatMoney(order.total_amount)}</td>
                  <td className="py-2.5 pr-3"><Chip>{order.status || "—"}</Chip></td>
                  <td className="py-2.5 pr-3"><Chip>{order.financial_status || "—"}</Chip></td>
                  <td className="whitespace-nowrap py-2.5 pr-3" title={placed?.toLocaleString()}>
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
      <Pager page={page} total={result.total} />
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
