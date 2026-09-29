"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { DownloadSimpleIcon } from "@/components/icons";
import { card, Empty, Panel } from "@/components/Panel";
import { eyebrow, focusRing, PageHeader, secondaryButton, small, Tabs } from "@/components/ui";
import { daysLeftPercent, historySummary, roughNote, shortDate, stockStatus } from "@/lib/format";
import { localDay } from "@/lib/overview";
import { perDayText, reorderCsv, SOON_DAYS, stockCounts } from "@/lib/stock";
import { jsonBody, useApi } from "@/lib/useApi";
import type { Forecast, InventoryItem, ItemForecast } from "@/lib/types";

// Tailwind only sees class names written out in full.
const BAR = { critical: "bg-critical", serious: "bg-serious", warning: "bg-warning", good: "bg-good" } as const;
const NUMBER = { critical: "text-critical", serious: "text-serious", warning: "text-warning", good: "" } as const;

// The item's own low-stock level, saved when changed.
function ThresholdField({ item, onSaved }: { item: InventoryItem; onSaved: () => Promise<void> }) {
  const call = useApi();
  const [value, setValue] = useState(String(item.low_stock_threshold));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = value !== String(item.low_stock_threshold);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await call(`/api/inventory/${item.id}`, { method: "PATCH", ...jsonBody({ low_stock_threshold: Number(value) }) });
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex items-center gap-1.5">
      <label htmlFor={`threshold-${item.id}`} className="sr-only">
        {item.item_name}: low at or below
      </label>
      <input
        id={`threshold-${item.id}`}
        type="number"
        min={0}
        step={1}
        required
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className={`w-16 rounded-md border border-border bg-field px-2 py-1 font-mono text-[13px] tabular-nums text-ink ${focusRing}`}
      />
      {changed && (
        <button type="submit" disabled={busy} className={`${secondaryButton} ${small}`}>
          {busy ? "Saving…" : "Save"}
        </button>
      )}
      {error && (
        <span role="alert" className="text-xs text-error" title={error}>
          Not saved
        </span>
      )}
    </form>
  );
}

const th = `${eyebrow} whitespace-nowrap px-3 py-3 text-left first:pl-5 last:pr-5`;
const td = "whitespace-nowrap px-3 py-3 first:pl-5 last:pr-5";

function StockRow({
  item,
  forecast,
  coverDays,
  lookbackDays,
  onSaved,
}: {
  item: InventoryItem;
  forecast?: ItemForecast;
  coverDays: number;
  lookbackDays: number;
  onSaved: () => Promise<void>;
}) {
  const status = stockStatus(item.stock_quantity, item.low_stock_threshold, forecast?.days_left, SOON_DAYS);
  const soldOut = item.stock_quantity <= 0;
  const percent = soldOut ? 0 : forecast ? daysLeftPercent(forecast.days_left, coverDays) : null;
  const rough = forecast && roughNote(forecast);
  const note = rough
    ? rough.charAt(0).toUpperCase() + rough.slice(1)
    : forecast && forecast.units_sold === 0
      ? `No sales in the last ${lookbackDays} days`
      : null;
  return (
    <tr className="border-t border-hairline" data-tone={status.tone}>
      <td className={`${td} whitespace-normal`}>
        <div className="min-w-40 font-semibold [overflow-wrap:anywhere]">{item.item_name}</div>
        {note && <div className="text-[11.5px] text-ink-2">{note}</div>}
      </td>
      <td className={`${td} font-mono ${soldOut ? "text-critical" : ""}`}>{item.stock_quantity}</td>
      <td className={`${td} font-mono`}>{forecast ? perDayText(forecast.per_day) : "—"}</td>
      <td className={td}>
        {percent == null ? (
          <span className="text-ink-2">{forecast ? "Not selling" : "—"}</span>
        ) : (
          <div
            className="flex w-44 items-center gap-2.5"
            role="meter"
            aria-label={`${item.item_name}: days of stock left`}
            aria-valuemin={0}
            aria-valuemax={coverDays}
            aria-valuenow={soldOut ? 0 : Math.round(forecast?.days_left ?? 0)}
          >
            <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-hairline">
              <div className={`h-full ${BAR[status.tone]}`} style={{ width: `${percent}%` }} />
            </div>
            <span className={`w-9 text-right font-mono ${NUMBER[status.tone]}`}>{soldOut ? 0 : Math.round(forecast?.days_left ?? 0)}</span>
          </div>
        )}
      </td>
      <td className={`${td} text-[12.5px] text-ink-2`}>{soldOut ? "Sold out" : forecast?.runs_out_at ? shortDate(forecast.runs_out_at) : "—"}</td>
      <td className={`${td} font-mono font-semibold`}>
        {forecast && forecast.reorder_quantity > 0 ? (
          <span title={forecast.units_sold > 0 ? `To last ${coverDays} days at the current pace` : "To cover what's oversold"}>
            {forecast.reorder_quantity} {forecast.reorder_quantity === 1 ? "unit" : "units"}
          </span>
        ) : (
          <span className="font-normal text-ink-2">—</span>
        )}
      </td>
      <td className={td}>
        <Badge label={status.label} tone={status.tone} />
      </td>
      <td className={td}>
        {/* Keyed by the saved value, so a save elsewhere (e.g. "apply to all") resets the field. */}
        <ThresholdField key={item.low_stock_threshold} item={item} onSaved={onSaved} />
      </td>
    </tr>
  );
}

function Stat({ label, value, tone = "" }: { label: string; value: number | null; tone?: string }) {
  return (
    <div className={`${card} grid gap-1 px-[18px] py-3.5`}>
      <span className="text-[12.5px] text-ink-2">{label}</span>
      <span className={`font-mono text-2xl font-bold ${tone}`}>{value ?? "…"}</span>
    </div>
  );
}

// The Reorder tab when it's empty: still loading, failed, no orders, or nothing needed.
function noReorderText(forecast: Forecast | null, error: string) {
  if (!forecast) return error || "Working out restock forecasts…";
  if (!forecast.history.from) return "No orders yet, so there's nothing to forecast from.";
  return `Nothing needs reordering to last the next ${forecast.cover_days} days.`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type Show = "low" | "reorder" | "all";
const SHOWS: Show[] = ["low", "reorder", "all"];

function StockView() {
  const { data, refresh, updatedAt } = useDashboard();
  const api = useApi();
  const router = useRouter();
  // The tab is kept in the URL (?show=reorder), so the Overview can link to it.
  const shown = useSearchParams().get("show");
  const show: Show = SHOWS.includes(shown as Show) ? (shown as Show) : "low";
  const setShow = (next: Show) => router.replace(next === "low" ? "/stock" : `/stock?show=${next}`, { scroll: false });
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [forecastError, setForecastError] = useState("");

  // Loaded again whenever the dashboard refreshes (every 30s, after a sync or a threshold change).
  useEffect(() => {
    let cancelled = false;
    api<Forecast>("/api/inventory/forecast")
      .then((body) => {
        if (cancelled) return;
        setForecast(body);
        setForecastError("");
      })
      .catch((err: Error) => {
        if (!cancelled) setForecastError(`Couldn't load restock forecasts: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [api, updatedAt]);

  if (!data) {
    return (
      <>
        <PageHeader title="Stock" />
        <Panel title="Stock">
          <Empty>Loading stock…</Empty>
        </Panel>
      </>
    );
  }

  const forecasts = new Map(forecast?.items.map((f) => [f.id, f]));
  const inventoryById = new Map(data.inventory.map((item) => [item.id, item]));
  // Soonest to run out first, as the forecast lists them.
  const toReorder = (forecast?.items ?? []).filter((f) => f.reorder_quantity > 0).flatMap((f) => inventoryById.get(f.id) ?? []);
  const items = show === "low" ? data.lowStock : show === "reorder" ? toReorder : data.inventory;
  const counts = stockCounts(data.inventory, forecast?.items ?? null);
  const coverDays = forecast?.cover_days ?? 30;
  const emptyText = {
    low: "Everything is above its low-stock level.",
    reorder: noReorderText(forecast, forecastError),
    all: "No tracked items yet. Use “Sync now” at the top.",
  }[show];

  return (
    <>
      <PageHeader
        title="Stock"
        sub={forecast ? historySummary(forecast.history, shortDate) : forecastError ? undefined : "Working out restock forecasts…"}
      >
        <button
          type="button"
          disabled={!forecast || toReorder.length === 0}
          onClick={() => forecast && download(`reorder-list-${localDay(new Date())}.csv`, reorderCsv(forecast.items, forecast.cover_days, (iso) => localDay(new Date(iso))))}
          className={`${secondaryButton} disabled:!cursor-not-allowed`}
          title={toReorder.length === 0 ? "Nothing to reorder right now" : "A CSV of what to reorder, soonest to run out first"}
        >
          <DownloadSimpleIcon aria-hidden="true" weight="bold" className="size-4" />
          Export reorder list
        </button>
      </PageHeader>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Tracked items" value={counts.tracked} />
        <Stat label={`Run out within ${SOON_DAYS} days`} value={counts.runningOut} tone={counts.runningOut ? "text-warning" : ""} />
        <Stat label="Out of stock" value={counts.outOfStock} tone={counts.outOfStock ? "text-critical" : ""} />
        <Stat label="To reorder" value={counts.toReorder} />
      </div>

      <Tabs
        label="Show"
        active={show}
        onSelect={setShow}
        tabs={[
          { key: "low", label: "Low", count: data.lowStock.length },
          { key: "reorder", label: "Reorder", count: forecast ? toReorder.length : null },
          { key: "all", label: "All items", count: data.inventory.length },
        ]}
      />

      {forecastError && (
        <p role="alert" className="text-sm text-error">
          {forecastError}
        </p>
      )}

      <section className={`${card} overflow-hidden`}>
        {!data.settings.store.connected && data.inventory.length === 0 ? (
          <div className="px-5 py-4">
            <Empty>
              Connect your store in{" "}
              <Link href="/settings" className="text-accent underline">
                Settings
              </Link>{" "}
              to see your stock here.
            </Empty>
          </div>
        ) : items.length === 0 ? (
          <div className="px-5 py-4">
            <Empty>{emptyText}</Empty>
          </div>
        ) : (
          // `relative` keeps the fields' screen-reader labels (absolutely placed) inside the scroll box.
          <div className="relative overflow-x-auto">
            <table className="w-full border-collapse text-[13.5px]">
              <thead>
                <tr>
                  <th scope="col" className={th}>Item</th>
                  <th scope="col" className={th}>In stock</th>
                  <th scope="col" className={th}>Sells / day</th>
                  <th scope="col" className={th}>Days left</th>
                  <th scope="col" className={th}>Runs out</th>
                  <th scope="col" className={th}>Reorder</th>
                  <th scope="col" className={th}>Status</th>
                  <th scope="col" className={th} title="The item counts as low at or below this">Low at</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <StockRow
                    key={item.id}
                    item={item}
                    forecast={forecasts.get(item.id)}
                    coverDays={coverDays}
                    lookbackDays={forecast?.lookback_days ?? 30}
                    onSaved={refresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-xs text-ink-2">
        An item counts as low at or below its level (the Low at column). New items start at {data.settings.inventory.default_low_stock_threshold}; change
        that in{" "}
        <Link href="/settings#stock" className="text-accent underline">
          Settings
        </Link>
        .
        {forecast &&
          ` Sales pace comes from the last ${forecast.lookback_days} days of orders (refunded ones don't count), and reorder amounts last ${forecast.cover_days} days at that pace. A forecast from under 3 orders or under a week of orders is marked as a rough estimate.`}
      </p>
    </>
  );
}

export default function StockPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense fallback={<Empty>Loading stock…</Empty>}>
      <StockView />
    </Suspense>
  );
}
