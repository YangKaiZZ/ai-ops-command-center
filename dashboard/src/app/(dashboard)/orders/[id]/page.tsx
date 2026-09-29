"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { BuyerName } from "@/components/BuyerName";
import { DecisionFeedback } from "@/components/DecisionFeedback";
import { useDashboard } from "@/components/DashboardProvider";
import { ArrowSquareOutIcon, CaretLeftIcon } from "@/components/icons";
import { Logo } from "@/components/Logo";
import { card, Empty, Panel } from "@/components/Panel";
import { ShopifyActions } from "@/components/ShopifyActions";
import { focusRing, PageHeader, secondaryButton } from "@/components/ui";
import { canRate } from "@/lib/feedback";
import {
  actionInfo,
  addressMatchText,
  formatMoney,
  fulfillmentBadge,
  parseReasoning,
  paymentBadge,
  riskBadge,
  riskSummary,
  timeAgo,
  type Tone,
} from "@/lib/format";
import { backToList } from "@/lib/orderFilters";
import type { HoldReason, OrderDetail } from "@/lib/types";
import { useApi } from "@/lib/useApi";

// Tailwind only sees class names written out in full.
const TONE_DOT: Record<Tone, string> = {
  good: "bg-good",
  warning: "bg-warning",
  serious: "bg-serious",
  critical: "bg-critical",
  neutral: "bg-ink-2/60",
};
const TONE_EDGE: Record<Tone, string> = {
  good: "border-good/35",
  warning: "border-warning/35",
  serious: "border-serious/35",
  critical: "border-critical/35",
  neutral: "",
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function LineItems({ detail }: { detail: OrderDetail }) {
  const { order } = detail;
  let rows: React.ReactNode;
  if (!detail.line_items) rows = <Empty>{detail.line_items_note ?? "This order's items aren't available."}</Empty>;
  else if (detail.line_items.length === 0) rows = <Empty>Shopify lists no items on this order.</Empty>;
  else {
    rows = (
      <ul>
        {detail.line_items.map((item) => {
          const variant = item.variant_title && item.variant_title !== "Default Title" ? item.variant_title : null;
          const toShip = item.fulfillable_quantity;
          const shipping = toShip === 0 ? "Shipped" : toShip != null && toShip < item.quantity ? `${toShip} still to ship` : null;
          const details = [variant, item.sku && `SKU ${item.sku}`, shipping].filter(Boolean).join(" · ");
          return (
            <li
              key={item.shopify_line_item_id}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-0.5 border-t border-hairline py-3 text-[13.5px] sm:grid-cols-[minmax(0,1fr)_60px_90px_90px]"
            >
              <span className="min-w-0">
                <span className="font-medium">{item.title}</span>
                {details && <span className="block text-xs text-ink-2">{details}</span>}
              </span>
              <span className="font-mono text-[12.5px] text-ink-2">× {item.quantity}</span>
              <span className="hidden text-right font-mono text-[12.5px] text-ink-2 sm:block">{formatMoney(item.price)}</span>
              <span className="text-right font-mono">{item.price == null ? "—" : formatMoney(String(Number(item.price) * item.quantity))}</span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <Panel title="Items">
      {rows}
      <div className="flex justify-between border-t border-hairline pt-3 text-sm font-bold">
        <span>
          Order total <span className="text-xs font-normal text-ink-2">(with shipping and tax)</span>
        </span>
        <span className="font-mono">{formatMoney(order.total_amount)}</span>
      </div>
    </Panel>
  );
}

// A signal: a short tag and what it means.
function Signal({ tag, tone, children }: { tag: string; tone: Tone; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[13px] leading-[1.45] text-ink-soft">
      <Badge label={tag} tone={tone} className="w-[62px] shrink-0 justify-center" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

// Shopify's fraud check: its verdict, the facts that raised the risk and the
// address check. The agent reads the same thing before deciding.
function FraudCheck({ detail }: { detail: OrderDetail }) {
  const { risk } = detail.order;
  if (!risk) {
    return (
      <Panel title="Fraud check">
        <Empty>{detail.risk_note ?? "Shopify's fraud check isn't available for this order."}</Empty>
      </Panel>
    );
  }
  const badge = riskBadge(risk);
  const address = risk.billing_matches_shipping;
  return (
    <Panel title="Fraud check" aside={<span title={new Date(risk.checked_at).toLocaleString()}>Checked {timeAgo(risk.checked_at)}</span>}>
      <ul className="grid gap-2.5 rounded-[10px] border border-hairline bg-well p-3.5">
        <Signal tag={risk.flagged ? "Risk" : risk.level === "pending" ? "Wait" : "OK"} tone={risk.flagged ? badge.tone : risk.level === "pending" ? "neutral" : "good"}>
          {riskSummary(risk)}
        </Signal>
        {risk.reasons.map((reason) => (
          <Signal key={reason} tag="Risk" tone="critical">
            {reason}
          </Signal>
        ))}
        <Signal tag={address === false ? "Note" : "OK"} tone={address === false ? "warning" : address === null ? "neutral" : "good"}>
          {addressMatchText(address)}
        </Signal>
      </ul>
    </Panel>
  );
}

// What happened to the order, newest first: placed, Shopify's fraud check and the agent's calls.
function Timeline({ detail }: { detail: OrderDetail }) {
  const { order } = detail;
  const events: { at: string; tone: Tone; text: React.ReactNode; sub?: string }[] = [];
  if (order.order_placed_at) events.push({ at: order.order_placed_at, tone: "neutral", text: "Order placed" });
  if (order.risk && order.risk.level !== "pending") {
    events.push({
      at: order.risk.checked_at,
      tone: order.risk.flagged ? "critical" : "neutral",
      text: order.risk.level === "none" ? "Shopify's fraud check gave no rating" : `Shopify rated it ${order.risk.level} risk`,
    });
  }
  for (const decision of detail.decisions) {
    const info = actionInfo(decision.action_taken);
    events.push({
      at: decision.created_at,
      tone: info.tone,
      text: decision.action_taken === "skipped" ? "The agent was skipped (daily limit)" : (
        <>
          Agent recommended <b className="font-semibold">{info.label}</b>
        </>
      ),
      sub: parseReasoning(decision.reasoning).headline || undefined,
    });
  }
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return (
    <Panel title="Timeline">
      {events.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ol className="grid gap-3">
          {events.map((event, i) => (
            <li key={i} className="flex gap-3 text-[13px]">
              <span aria-hidden="true" className={`mt-[5px] size-2 shrink-0 ${TONE_DOT[event.tone]}`} />
              <div className="min-w-0">
                <div>{event.text}</div>
                {event.sub && <div className="text-ink-soft">{event.sub}</div>}
                <time className="text-[12.5px] text-ink-2" dateTime={event.at} title={new Date(event.at).toLocaleString()}>
                  {when(event.at)}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

// The agent's latest call on the order, its reasons, and the seller's rating.
function AgentCall({ detail }: { detail: OrderDetail }) {
  const { refresh } = useDashboard();
  const latest = detail.decisions[0];
  if (!latest) {
    return (
      <section className={`${card} grid gap-2 px-5 py-[18px]`}>
        <h2 className="flex items-center gap-2 font-display text-[16.5px] font-semibold tracking-[-0.015em]">
          <Logo className="size-4" />
          Agent&rsquo;s call
        </h2>
        <Empty>The agent hasn&rsquo;t looked at this order. It checks each new order as it comes in.</Empty>
      </section>
    );
  }
  const info = actionInfo(latest.action_taken);
  const { headline, blocks } = parseReasoning(latest.reasoning);
  const earlier = detail.decisions.length - 1;
  return (
    <section className={`${card} grid gap-3.5 px-5 py-[18px] ${TONE_EDGE[info.tone]}`} data-decision={latest.id}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-[16.5px] font-semibold tracking-[-0.015em]">
          <Logo className="size-4" />
          Agent&rsquo;s call
        </h2>
        <Badge label={info.label} tone={info.tone} className="!px-3 !py-1 !text-[12.5px]" />
      </div>
      {headline && <p className="text-sm leading-[1.55]">{headline}</p>}
      {blocks.length > 0 && (
        <div className="grid gap-1.5 rounded-[10px] border border-hairline bg-well p-3.5 text-[13px] leading-[1.45] text-ink-soft">
          <p className="text-[11.5px] uppercase tracking-[0.06em] text-ink-2">Why</p>
          {blocks.map((block, i) =>
            block.type === "bullets" ? (
              <ul key={i} className="grid list-disc gap-1 pl-4">
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            ) : (
              <p key={i}>{block.text}</p>
            )
          )}
        </div>
      )}
      <p className="text-[12.5px] text-ink-2">
        <time dateTime={latest.created_at} title={new Date(latest.created_at).toLocaleString()}>
          {timeAgo(latest.created_at)}
        </time>
        {earlier > 0 && ` · ${earlier} earlier ${earlier === 1 ? "call" : "calls"} in the timeline`}
      </p>
      {canRate(latest.action_taken) && <DecisionFeedback decision={latest} onSaved={() => refresh()} />}
    </section>
  );
}

// The hold reason to start the form with: fraud if the fraud check flagged
// it, a pending payment, or "other".
function suggestedHoldReason(order: OrderDetail["order"]): HoldReason {
  if (order.risk?.flagged) return "HIGH_RISK_OF_FRAUD";
  if (order.financial_status === "pending" || order.financial_status === "partially_paid") return "AWAITING_PAYMENT";
  return "OTHER";
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
    <Link href={back} className={`-mb-1.5 inline-flex w-fit items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink ${focusRing}`}>
      <CaretLeftIcon aria-hidden="true" weight="bold" className="size-3.5" />
      Back to orders
    </Link>
  );

  if (notFound || !validId) {
    return (
      <>
        {backLink}
        <Panel title="Order not found">
          <Empty>There&rsquo;s no order with that id in your store.</Empty>
        </Panel>
      </>
    );
  }
  if (!detail) {
    return (
      <>
        {backLink}
        <Panel title="Order">
          <Empty>{error || "Loading the order…"}</Empty>
        </Panel>
      </>
    );
  }

  const { order } = detail;
  const itemCount = detail.line_items?.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <>
      {backLink}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono">{order.order_number ?? `Order ${order.id}`}</span>
            <Badge {...paymentBadge(order.financial_status)} />
            <Badge {...fulfillmentBadge(order.status)} />
            {order.risk && (order.risk.flagged || order.risk.level === "pending") && <Badge label={riskBadge(order.risk).label} tone={riskBadge(order.risk).tone} />}
          </span>
        }
        sub={
          <>
            {order.order_placed_at ? `Placed ${when(order.order_placed_at)}` : "Placed —"} · <BuyerName name={order.buyer_name} />
            {itemCount != null && ` · ${itemCount} ${itemCount === 1 ? "item" : "items"}`}
          </>
        }
      >
        {detail.shopify_admin_url && (
          <a href={detail.shopify_admin_url} target="_blank" rel="noopener noreferrer" className={secondaryButton}>
            Open in Shopify
            <ArrowSquareOutIcon aria-hidden="true" className="size-4" />
          </a>
        )}
      </PageHeader>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="grid gap-4">
          <LineItems detail={detail} />
          <FraudCheck detail={detail} />
          <Timeline detail={detail} />
        </div>
        <div className="grid gap-4 max-lg:row-start-1">
          <AgentCall detail={detail} />
          <ShopifyActions orderId={order.id} suggestedReason={suggestedHoldReason(order)} />
        </div>
      </div>
    </>
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
