"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { BuyerName } from "@/components/BuyerName";
import { useDashboard } from "@/components/DashboardProvider";
import { MinusIcon, TrendDownIcon, TrendUpIcon } from "@/components/icons";
import { card, Empty, Panel } from "@/components/Panel";
import { SetupChecklist } from "@/components/SetupChecklist";
import { accentOutlineButton, focusRing, PageHeader, secondaryButton, small } from "@/components/ui";
import { accuracyPercent } from "@/lib/feedback";
import { actionInfo, ACTIONS, formatMoney, historySummary, parseReasoning, riskSummary, roughNote, shortDate, timeAgo } from "@/lib/format";
import { change, fraudComparison, localDay, percentChange, PERIOD_CHOICES, periodStart, readPeriod, tileCount, tileMoney } from "@/lib/overview";
import type { Action, Decision, Order, OrdersPage, Overview } from "@/lib/types";
import { useApi } from "@/lib/useApi";

// The change against the period before: an arrow and a signed number, so it
// never rests on color alone. More orders or sales is the good direction.
const TRENDS = {
  up: { Glyph: TrendUpIcon, tone: "text-good" },
  down: { Glyph: TrendDownIcon, tone: "text-critical" },
  same: { Glyph: MinusIcon, tone: "text-ink-2" },
};

function ChangeLine({ current, previous, format, days }: { current: number; previous: number; format: (n: number) => string; days: number }) {
  const value = change(current, previous, format);
  const percent = percentChange(current, previous);
  const { Glyph, tone } = TRENDS[value.direction];
  return (
    <span className="text-[12.5px] text-ink-2">
      <span className={`inline-flex items-center gap-1 font-semibold tabular-nums ${tone}`}>
        <Glyph aria-hidden="true" weight="bold" className="size-3.5" />
        {value.text}
        {percent && ` (${percent})`}
      </span>{" "}
      vs the {days} days before
    </span>
  );
}

// One number with its label. The whole card is the link (the label's link is
// stretched over it); anything linked inside sits above it with `relative`.
function Tile({
  label,
  value,
  href,
  alarm = false,
  badge,
  children,
}: {
  label: string;
  value: string;
  href: string;
  alarm?: boolean; // tinted edge: something here needs the seller
  badge?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`${card} relative grid content-start gap-1.5 px-4 py-4 transition-colors hover:border-accent/45 sm:px-5 sm:py-[18px] ${alarm ? "border-critical/35" : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={href} className={`text-[12.5px] text-ink-2 after:absolute after:inset-0 after:rounded-xl ${focusRing}`}>
          {label}
        </Link>
        {badge}
      </div>
      <span className="font-mono text-[26px] font-bold leading-tight tracking-[-0.02em] tabular-nums sm:text-[30px]">{value}</span>
      {children}
    </div>
  );
}

// The main button for an order waiting on the seller: the agent's call, done
// from the order's "In Shopify" panel (which asks before it changes anything).
const ACT: Partial<Record<Action, string>> = { fulfill: "Mark fulfilled", hold: "Put on hold" };

// Orders that still need action, each with the agent's latest call and why.
function WaitingOnYou({ orders, total, decisions }: { orders: Order[] | null; total: number; decisions: Decision[] }) {
  const latestFor = (orderId: number) => decisions.find((d) => d.order_id === orderId);
  return (
    <section className={`${card} flex flex-col overflow-hidden`}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-5 py-4">
        <div>
          <h2 className="font-display text-[15.5px] font-semibold tracking-[-0.005em]">Waiting on you</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-2">Orders still to ship or check, with the agent&rsquo;s call on each</p>
        </div>
        <Link href="/orders?needs_action=1" className={`text-[12.5px] text-ink-2 hover:text-ink ${focusRing}`}>
          {total > 0 ? `All ${total} →` : "All orders →"}
        </Link>
      </div>
      {!orders ? (
        <div className="border-t border-hairline px-5 py-3.5">
          <Empty>Loading…</Empty>
        </div>
      ) : orders.length === 0 ? (
        <div className="border-t border-hairline px-5 py-3.5">
          <Empty>Nothing waiting on you. New orders show up here with the agent&rsquo;s call.</Empty>
        </div>
      ) : (
        <ul>
          {orders.map((order) => {
            const verdict = order.latest_decision?.action_taken;
            const info = verdict ? actionInfo(verdict) : null;
            const decision = latestFor(order.id);
            const why = decision ? parseReasoning(decision.reasoning).headline : order.risk?.flagged ? riskSummary(order.risk) : null;
            const act = verdict ? ACT[verdict] : undefined;
            const href = `/orders/${order.id}`;
            return (
              <li key={order.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-hairline px-5 py-3.5">
                <span className="w-[74px] shrink-0">
                  {info ? (
                    <Badge label={info.label} tone={info.tone} className="w-full justify-center" />
                  ) : (
                    <Badge label="No call" tone="neutral" className="w-full justify-center" />
                  )}
                </span>
                <div className="min-w-0 flex-1 basis-60">
                  <p className="text-sm font-semibold">
                    <Link href={href} className={`font-mono hover:text-accent ${focusRing}`}>
                      {order.order_number ?? `Order ${order.id}`}
                    </Link>
                    <span className="font-normal text-ink-2">
                      {" · "}
                      <BuyerName name={order.buyer_name} />
                      {" · "}
                    </span>
                    <span className="font-mono">{formatMoney(order.total_amount)}</span>
                  </p>
                  <p className="mt-0.5 truncate text-[12.5px] text-ink-2" title={why ?? undefined}>
                    {why ?? (order.order_placed_at ? `Placed ${timeAgo(order.order_placed_at)}` : "The agent hasn't looked at it yet")}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Link href={href} className={`${secondaryButton} ${small}`}>
                    Open
                  </Link>
                  {act && (
                    <Link href={`${href}#in-shopify`} className={`${accentOutlineButton} ${small}`}>
                      {act}…
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Days left in the item's color: under 3 days is serious, else a warning.
function daysTone(days: number) {
  return days < 3 ? "text-serious" : "text-warning";
}

const VERDICT_BARS: { key: Action; bar: string }[] = [
  { key: "fulfill", bar: "bg-good" },
  { key: "hold", bar: "bg-warning" },
  { key: "low_stock_alert", bar: "bg-serious" },
  { key: "unknown", bar: "bg-neutral" },
  { key: "skipped", bar: "bg-hairline" },
];

function AgentCard({ decisions, days }: { decisions: Overview["decisions"]; days: number }) {
  const percent = accuracyPercent(decisions.ratings);
  const rated = decisions.ratings.up + decisions.ratings.down;
  const shown = VERDICT_BARS.filter((v) => decisions[v.key] > 0);
  return (
    <Panel title={`Agent, last ${days} days`} aside={`${tileCount(decisions.total)} ${decisions.total === 1 ? "decision" : "decisions"}`} className="flex-1">
      <div className="grid gap-3">
        {percent !== null ? (
          <p className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="font-mono text-[30px] font-bold leading-tight tracking-[-0.02em]">{percent}%</span>
            <span className="text-[12.5px] text-ink-2">
              right · {decisions.ratings.up} of {rated} rated
            </span>
          </p>
        ) : (
          <p className="text-[12.5px] text-ink-2">
            {decisions.total > decisions.skipped ? (
              <>
                None rated yet.{" "}
                <Link href="/decisions?show=unrated" className="text-accent hover:underline">
                  Rate its calls
                </Link>{" "}
                to see how often it&rsquo;s right.
              </>
            ) : (
              "No calls in this period."
            )}
          </p>
        )}
        {decisions.total > 0 && (
          <>
            <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-sm" aria-hidden="true">
              {shown.map((v) => (
                <div key={v.key} className={v.bar} style={{ width: `${(decisions[v.key] / decisions.total) * 100}%` }} />
              ))}
            </div>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-soft">
              {shown.map((v) => (
                <span key={v.key} className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className={`size-[7px] ${v.bar}`} />
                  {ACTIONS[v.key].label} <span className="font-mono">{decisions[v.key]}</span>
                </span>
              ))}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

function OverviewView({
  overview,
  waiting,
  decisions,
  days,
}: {
  overview: Overview;
  waiting: OrdersPage | null;
  decisions: Decision[];
  days: number;
}) {
  const { orders, fraud, stock } = overview;
  const from = localDay(new Date(overview.period.from));
  const oldest = orders.oldest_unshipped;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <Tile label="Orders" value={tileCount(orders.count)} href={`/orders?from=${from}`}>
          <ChangeLine current={orders.count} previous={orders.previous_count} format={tileCount} days={days} />
        </Tile>
        <Tile label="Sales" value={tileMoney(Number(orders.sales))} href={`/orders?from=${from}`}>
          <ChangeLine current={Number(orders.sales)} previous={Number(orders.previous_sales)} format={tileMoney} days={days} />
        </Tile>
        <Tile label="Need action" value={tileCount(orders.needs_action)} href="/orders?needs_action=1">
          <span className="text-[12.5px] text-ink-soft">
            {oldest ? (
              <>
                Oldest{" "}
                <Link href={`/orders/${oldest.id}`} className={`relative z-10 font-mono text-accent hover:underline ${focusRing}`}>
                  {oldest.order_number ?? `order ${oldest.id}`}
                </Link>
                , placed {timeAgo(oldest.order_placed_at)}
              </>
            ) : (
              "Nothing waiting to ship"
            )}
          </span>
        </Tile>
        <Tile
          label="Flagged for fraud"
          value={tileCount(fraud.flagged)}
          href={`/orders?risk=flagged&from=${from}`}
          alarm={fraud.flagged_needs_action > 0}
          badge={fraud.flagged_needs_action > 0 ? <Badge label="Needs a look" tone="critical" /> : undefined}
        >
          <span className="text-[12.5px] text-ink-soft">
            {fraud.flagged_needs_action ? (
              <Link href="/orders?risk=flagged&needs_action=1" className={`relative z-10 font-medium text-critical hover:underline ${focusRing}`}>
                {tileCount(fraud.flagged_needs_action)} still {fraud.flagged_needs_action === 1 ? "needs" : "need"} action
              </Link>
            ) : (
              "None waiting on you"
            )}
            {" · "}
            <span className="text-ink-2">{fraudComparison(fraud.previous_flagged, days)}</span>
          </span>
        </Tile>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <WaitingOnYou orders={waiting?.orders ?? null} total={waiting?.total ?? 0} decisions={decisions} />

        <div className="flex flex-col gap-4">
          <Panel
            title={`Runs out within ${stock.running_out_within_days} days`}
            aside={
              <Link href="/stock?show=reorder" className={`hover:text-ink ${focusRing}`}>
                Reorder list →
              </Link>
            }
          >
            {stock.running_out.length === 0 ? (
              <Empty>Nothing, at the current pace.</Empty>
            ) : (
              <ul>
                {stock.running_out.map((item) => {
                  const rough = roughNote(item);
                  const left = Math.max(1, Math.round(item.days_left ?? 0));
                  return (
                    <li key={item.id} className="flex items-center justify-between gap-3 border-t border-hairline py-[11px]">
                      <span className="min-w-0 text-[13.5px]">
                        <Link href="/stock?show=reorder" className={`hover:text-accent ${focusRing}`}>
                          {item.item_name}
                        </Link>
                        <span className="block text-xs text-ink-2">
                          {item.stock_quantity} left · reorder {item.reorder_quantity}
                          {rough && ` · ${rough}`}
                        </span>
                      </span>
                      <span className={`shrink-0 font-mono text-[12.5px] ${daysTone(item.days_left ?? 0)}`}>
                        {left} {left === 1 ? "day" : "days"}
                        {item.runs_out_at && ` · ${shortDate(item.runs_out_at)}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-2 flex flex-wrap gap-x-3 border-t border-hairline pt-2.5 text-[12.5px] text-ink-soft">
              <Link href="/stock" className="hover:text-ink">
                <span className="font-mono">{tileCount(stock.low)}</span> running low
              </Link>
              <span>
                <span className="font-mono">{tileCount(stock.out_of_stock)}</span> out of stock
              </span>
              <Link href="/stock?show=reorder" className="hover:text-ink">
                <span className="font-mono">{tileCount(stock.to_reorder)}</span> to reorder
              </Link>
            </p>
            <p className="mt-2 text-[11.5px] text-ink-2">{historySummary(stock.forecast.history, shortDate)}</p>
          </Panel>

          <AgentCard decisions={overview.decisions} days={days} />
        </div>
      </div>
      <p className="text-xs text-ink-2">Sales are order totals; refunded and voided orders are left out.</p>
    </>
  );
}

function OverviewContent() {
  const { data, updatedAt } = useDashboard();
  const api = useApi();
  const days = readPeriod(useSearchParams().get("days"));
  const [overview, setOverview] = useState<(Overview & { days: number }) | null>(null);
  const [waiting, setWaiting] = useState<OrdersPage | null>(null);
  const [error, setError] = useState("");

  // Loaded again whenever the dashboard refreshes. The period starts at local
  // midnight days-1 days ago, so it matches the Orders page's date filter.
  useEffect(() => {
    let cancelled = false;
    const from = periodStart(new Date(), days).toISOString();
    Promise.all([
      api<Overview>(`/api/overview?from=${encodeURIComponent(from)}`),
      api<OrdersPage>("/api/orders?needs_action=true&limit=5"),
    ])
      .then(([body, pending]) => {
        if (cancelled) return;
        setOverview({ ...body, days });
        setWaiting(pending);
        setError("");
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Couldn't load the overview: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [api, updatedAt, days]);

  const shown = overview && overview.days === days ? overview : null;
  const range = shown ? `${shortDate(shown.period.from)} – ${shortDate(shown.period.to)}` : `Last ${days} days`;

  return (
    <>
      <PageHeader title="Overview" sub={`${range} · compared with the ${days} days before`}>
        <div role="group" aria-label="Period" className="flex rounded-[9px] border border-border bg-field p-[3px]">
          {PERIOD_CHOICES.map((choice) => (
            <Link
              key={choice}
              href={choice === 7 ? "/overview" : `/overview?days=${choice}`}
              scroll={false}
              aria-current={choice === days ? "true" : undefined}
              className={`rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${focusRing} ${
                choice === days ? "bg-hairline text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {choice} days
            </Link>
          ))}
        </div>
      </PageHeader>
      {data && <SetupChecklist settings={data.settings} />}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {overview ? (
        <div className={`grid gap-4 ${shown ? "" : "opacity-60"}`} aria-busy={!shown}>
          <OverviewView overview={overview} waiting={waiting} decisions={data?.decisions ?? []} days={overview.days} />
        </div>
      ) : (
        !error && (
          <Panel title="Overview">
            <Empty>Loading the overview…</Empty>
          </Panel>
        )
      )}
    </>
  );
}

export default function OverviewPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense fallback={<Empty>Loading the overview…</Empty>}>
      <OverviewContent />
    </Suspense>
  );
}
