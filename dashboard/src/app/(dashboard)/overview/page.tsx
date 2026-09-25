"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { SetupChecklist } from "@/components/SetupChecklist";
import { ACTIONS, formatDaysLeft, historySummary, roughNote, shortDate, timeAgo } from "@/lib/format";
import { change, localDay, periodStart, PERIOD_DAYS, tileCount, tileMoney, type Change } from "@/lib/overview";
import type { Action, Overview } from "@/lib/types";
import { useApi } from "@/lib/useApi";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// The change against the period before: an arrow and a signed number, so it
// never rests on color alone. More orders or sales is the good direction.
function ChangeLine({ value }: { value: Change }) {
  const arrow = { up: { glyph: "↑", tone: "text-good" }, down: { glyph: "↓", tone: "text-critical" }, same: { glyph: "→", tone: "text-ink-2" } }[
    value.direction
  ];
  return (
    <span className="text-sm text-ink-2">
      <span aria-hidden="true" className={`font-semibold ${arrow.tone}`}>
        {arrow.glyph}
      </span>{" "}
      {value.text} vs the {PERIOD_DAYS} days before
    </span>
  );
}

// One number with its label. The whole card is the link (the label's link is
// stretched over it); anything linked inside sits above it with `relative`.
function Tile({ label, value, href, children }: { label: string; value: string; href: string; children?: React.ReactNode }) {
  return (
    <div className="relative grid content-start gap-1 rounded-xl border border-border bg-surface p-4 hover:border-ink/25">
      <Link href={href} className={`text-sm font-medium text-ink-2 after:absolute after:inset-0 after:rounded-xl ${focusRing}`}>
        {label}
      </Link>
      <span className="text-3xl font-semibold leading-tight">{value}</span>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2.5">
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const VERDICTS: Action[] = ["fulfill", "hold", "low_stock_alert", "skipped", "unknown"];

function OverviewView({ overview }: { overview: Overview }) {
  const { orders, stock, decisions } = overview;
  const from = localDay(new Date(overview.period.from));
  const oldest = orders.oldest_unshipped;

  return (
    <div className="grid gap-5">
      <p className="text-sm text-ink-2">
        Last {PERIOD_DAYS} days ({shortDate(overview.period.from)} to today), compared with the {PERIOD_DAYS} days before.
      </p>

      <Section title="Orders">
        <div className="grid gap-3 sm:grid-cols-3">
          <Tile label="Orders" value={tileCount(orders.count)} href={`/orders?from=${from}`}>
            <ChangeLine value={change(orders.count, orders.previous_count, tileCount)} />
          </Tile>
          <Tile label="Sales" value={tileMoney(Number(orders.sales))} href={`/orders?from=${from}`}>
            <ChangeLine value={change(Number(orders.sales), Number(orders.previous_sales), tileMoney)} />
          </Tile>
          <Tile label="Need action" value={tileCount(orders.needs_action)} href="/orders?needs_action=1">
            <span className="text-sm text-ink-2">
              {oldest ? (
                <>
                  Oldest unshipped:{" "}
                  <Link href={`/orders/${oldest.id}`} className={`relative z-10 text-accent underline ${focusRing}`}>
                    {oldest.order_number ?? `order ${oldest.id}`}
                  </Link>
                  , placed {timeAgo(oldest.order_placed_at)}
                </>
              ) : (
                "Nothing waiting to ship"
              )}
            </span>
          </Tile>
        </div>
        <p className="text-xs text-ink-2">Sales are order totals; refunded and voided orders are left out.</p>
      </Section>

      <Section title="Stock">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Tile label="Running low" value={tileCount(stock.low)} href="/stock">
            <span className="text-sm text-ink-2">
              {stock.out_of_stock ? `${tileCount(stock.out_of_stock)} out of stock` : "None out of stock"}, of {tileCount(stock.tracked)} tracked
            </span>
          </Tile>
          <Tile label="To reorder" value={tileCount(stock.to_reorder)} href="/stock?show=reorder">
            <span className="text-sm text-ink-2">To last {stock.forecast.cover_days} days at the current pace</span>
          </Tile>
          <div className="grid content-start gap-2 rounded-xl border border-border bg-surface p-4 sm:col-span-2 lg:col-span-1">
            <h3 className="text-sm font-medium text-ink-2">Runs out within {stock.running_out_within_days} days</h3>
            {stock.running_out.length === 0 ? (
              <p className="text-sm text-ink-2">Nothing, at the current pace.</p>
            ) : (
              <ul className="grid gap-2">
                {stock.running_out.map((item) => {
                  const rough = roughNote(item);
                  return (
                    <li key={item.id} className="grid text-sm">
                      <Link href="/stock?show=reorder" className={`font-medium hover:underline ${focusRing}`}>
                        {item.item_name}
                      </Link>
                      <span className="text-ink-2">
                        {item.stock_quantity} left, runs out in {formatDaysLeft(item.days_left ?? 0)}
                        {item.runs_out_at && ` (${shortDate(item.runs_out_at)})`} · <span className="font-medium text-ink">Reorder {item.reorder_quantity}</span>
                        {rough && ` · ${rough}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <p className="text-xs text-ink-2">{historySummary(stock.forecast.history, shortDate)}</p>
      </Section>

      <Section title="Agent">
        <Tile label="Decisions" value={tileCount(decisions.total)} href="/decisions">
          <span className="flex flex-wrap gap-1.5">
            {VERDICTS.filter((v) => v !== "unknown" || decisions.unknown > 0).map((v) => (
              <Badge key={v} label={`${ACTIONS[v].label} ${decisions[v]}`} tone={decisions[v] ? ACTIONS[v].tone : "neutral"} icon={ACTIONS[v].icon} />
            ))}
          </span>
        </Tile>
      </Section>
    </div>
  );
}

export default function OverviewPage() {
  const { data, updatedAt } = useDashboard();
  const api = useApi();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");

  // Loaded again whenever the dashboard refreshes. The period starts at local
  // midnight 6 days ago, so it matches the Orders page's date filter.
  useEffect(() => {
    let cancelled = false;
    const from = periodStart(new Date()).toISOString();
    api<Overview>(`/api/overview?from=${encodeURIComponent(from)}`)
      .then((body) => {
        if (cancelled) return;
        setOverview(body);
        setError("");
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Couldn't load the overview: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [api, updatedAt]);

  return (
    <div className="grid gap-4">
      {data && <SetupChecklist settings={data.settings} />}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {overview ? (
        <OverviewView overview={overview} />
      ) : (
        !error && (
          <Panel title="Overview">
            <Empty>Loading the overview…</Empty>
          </Panel>
        )
      )}
    </div>
  );
}
