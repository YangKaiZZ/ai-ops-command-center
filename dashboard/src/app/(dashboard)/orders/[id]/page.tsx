"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { DecisionCard } from "@/components/DecisionCard";
import { useDashboard } from "@/components/DashboardProvider";
import { ArrowLeftIcon, ArrowSquareOutIcon } from "@/components/icons";
import { Empty, Panel } from "@/components/Panel";
import { addressMatchText, formatMoney, riskBadge, riskSummary, timeAgo } from "@/lib/format";
import { backToList } from "@/lib/orderFilters";
import type { OrderDetail } from "@/lib/types";
import { useApi } from "@/lib/useApi";

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full border border-border bg-ink/5 px-2 text-xs text-ink-2">{children}</span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function LineItems({ detail }: { detail: OrderDetail }) {
  if (!detail.line_items) return <Empty>{detail.line_items_note ?? "This order's items aren't available."}</Empty>;
  if (detail.line_items.length === 0) return <Empty>Shopify lists no items on this order.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hairline text-left font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-ink-2">
            <th scope="col" className="pb-2 pr-3">Item</th>
            <th scope="col" className="whitespace-nowrap pb-2 pr-3">SKU</th>
            <th scope="col" className="whitespace-nowrap pb-2 pr-3 text-right">Qty</th>
            <th scope="col" className="whitespace-nowrap pb-2 pr-3 text-right">To ship</th>
            <th scope="col" className="whitespace-nowrap pb-2 pr-3 text-right">Price</th>
            <th scope="col" className="whitespace-nowrap pb-2 text-right">Line total</th>
          </tr>
        </thead>
        <tbody>
          {detail.line_items.map((item) => (
            <tr key={item.shopify_line_item_id} className="border-b border-hairline last:border-0">
              <td className="py-2.5 pr-3">
                <span className="font-medium">{item.title}</span>
                {item.variant_title && item.variant_title !== "Default Title" && (
                  <span className="block text-xs text-ink-2">{item.variant_title}</span>
                )}
              </td>
              <td className="whitespace-nowrap py-2.5 pr-3 text-ink-2">{item.sku ?? "—"}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">{item.quantity}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">{item.fulfillable_quantity ?? "—"}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">{formatMoney(item.price)}</td>
              <td className="py-2.5 text-right tabular-nums">
                {item.price == null ? "—" : formatMoney(String(Number(item.price) * item.quantity))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Shopify's fraud check: its verdict, the facts that raised the risk and the
// address check. The agent reads the same thing before deciding.
function FraudCheck({ detail }: { detail: OrderDetail }) {
  const { risk } = detail.order;
  if (!risk) return <Empty>{detail.risk_note ?? "Shopify's fraud check isn't available for this order."}</Empty>;
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge {...riskBadge(risk)} />
        <p>{riskSummary(risk)}</p>
      </div>
      {risk.reasons.length > 0 && (
        <div>
          <p className="mb-1 text-ink-2">What raised the risk:</p>
          <ul className="grid list-disc gap-0.5 pl-5">
            {risk.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      <p className={risk.billing_matches_shipping === false ? "" : "text-ink-2"}>{addressMatchText(risk.billing_matches_shipping)}</p>
      <p className="text-xs text-ink-2" title={new Date(risk.checked_at).toLocaleString()}>
        Checked {timeAgo(risk.checked_at)}
      </p>
    </div>
  );
}

function OrderView() {
  const { id } = useParams<{ id: string }>();
  const back = backToList(useSearchParams().get("back"));
  const { updatedAt } = useDashboard();
  const api = useApi();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [notFound, setNotFound] = useState(false);
  const validId = /^\d+$/.test(id);

  // Loaded again whenever the dashboard refreshes, so statuses and new decisions show up.
  useEffect(() => {
    if (!validId) return;
    let cancelled = false;
    api<OrderDetail>(`/api/orders/${id}`)
      .then((body) => {
        if (cancelled) return;
        setDetail(body);
        setError("");
      })
      .catch((err: Error) => {
        if (cancelled) return;
        if (/not found/i.test(err.message)) setNotFound(true);
        else setError(`Couldn't load this order: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [api, id, validId, updatedAt]);

  const backLink = (
    <Link href={back} className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-accent hover:underline">
      <ArrowLeftIcon aria-hidden="true" weight="bold" className="size-4" />
      Back to orders
    </Link>
  );

  if (notFound || !validId) {
    return (
      <div className="grid gap-3">
        {backLink}
        <Panel title="Order not found">
          <Empty>There&rsquo;s no order with that id in your store.</Empty>
        </Panel>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="grid gap-3">
        {backLink}
        <Panel title="Order">
          <Empty>{error || "Loading the order…"}</Empty>
        </Panel>
      </div>
    );
  }

  const { order } = detail;
  const placed = order.order_placed_at ? new Date(order.order_placed_at) : null;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {backLink}
        {detail.shopify_admin_url && (
          <a
            href={detail.shopify_admin_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium transition-colors hover:border-ink-2/40 hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Open in Shopify
            <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
          </a>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <Panel title={`Order ${order.order_number ?? order.id}`}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
          <Field label="Customer">{order.buyer_name || "Guest"}</Field>
          <Field label="Total">
            <span className="tabular-nums">{formatMoney(order.total_amount)}</span>
          </Field>
          <Field label="Shipping">
            <Chip>{order.status || "—"}</Chip>
          </Field>
          <Field label="Payment">
            <Chip>{order.financial_status || "—"}</Chip>
          </Field>
          <Field label="Placed">{placed ? placed.toLocaleString() : "—"}</Field>
        </dl>
      </Panel>
      <Panel title="Fraud check">
        <FraudCheck detail={detail} />
      </Panel>
      <Panel title="Items">
        <LineItems detail={detail} />
      </Panel>
      <Panel title="Agent decisions">
        {detail.decisions.length === 0 ? (
          <Empty>The agent hasn&rsquo;t looked at this order. It checks each new order as it comes in.</Empty>
        ) : (
          <ol className="grid gap-2.5">
            {detail.decisions.map((decision, i) => (
              <DecisionCard key={decision.id} decision={decision} title={i === 0 ? "Latest" : "Earlier"} />
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

export default function OrderPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense fallback={<Empty>Loading the order…</Empty>}>
      <OrderView />
    </Suspense>
  );
}
