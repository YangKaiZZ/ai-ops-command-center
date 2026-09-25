"use client";

import Link from "next/link";
import { Fragment, Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { secondaryButton } from "@/components/ui";
import { forecastPhrases, historySummary, roughNote, shortDate, stockPercent, stockTone } from "@/lib/format";
import { jsonBody, useApi } from "@/lib/useApi";
import type { Forecast, InventoryItem, ItemForecast } from "@/lib/types";

// Fill = the status color; track = a lighter step of the same hue.
const METER_CLASSES = {
  critical: { track: "bg-critical/20", fill: "bg-critical" },
  warning: { track: "bg-warning/25", fill: "bg-warning" },
  good: { track: "bg-good/20", fill: "bg-good" },
} as const;

const STATUS_BADGES = {
  critical: <Badge label="Out of stock" tone="critical" icon="empty" />,
  warning: <Badge label="Low" tone="warning" icon="alert" />,
  good: <Badge label="OK" tone="good" icon="check" />,
} as const;

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
    <form onSubmit={save} className="flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={`threshold-${item.id}`} className="text-ink-2">
        Low at or below
      </label>
      <input
        id={`threshold-${item.id}`}
        type="number"
        min={0}
        step={1}
        required
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-20 rounded-lg border border-hairline bg-page px-2 py-1 text-sm tabular-nums text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      {changed && (
        <button type="submit" disabled={busy} className={`${secondaryButton} py-1`}>
          {busy ? "Saving…" : "Save"}
        </button>
      )}
      {error && (
        <span role="alert" className="text-error">
          {error}
        </span>
      )}
    </form>
  );
}

// How fast it sells, when it runs out and how many to reorder, e.g.
// "Sells about 1.3 a day · runs out in about 8 days (Oct 3) · Reorder 30 to last 30 days".
function ForecastLine({ forecast, lookbackDays, coverDays }: { forecast: ItemForecast; lookbackDays: number; coverDays: number }) {
  const parts: React.ReactNode[] = forecastPhrases(forecast, lookbackDays, shortDate);
  if (forecast.reorder_quantity > 0) {
    parts.push(
      <>
        <span className="font-medium text-ink">Reorder {forecast.reorder_quantity}</span>{" "}
        {/* Not selling but below zero: the reorder is what's already been sold. */}
        {forecast.units_sold > 0 ? `to last ${coverDays} days` : "to cover what's oversold"}
      </>
    );
  }
  const rough = roughNote(forecast);
  if (rough) parts.push(rough);
  return (
    <p className="text-sm text-ink-2">
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && " · "}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

type ForecastContext = { lookbackDays: number; coverDays: number };

function StockRow({
  item,
  forecast,
  context,
  onSaved,
}: {
  item: InventoryItem;
  forecast?: ItemForecast;
  context?: ForecastContext;
  onSaved: () => Promise<void>;
}) {
  const tone = stockTone(item.stock_quantity, item.low_stock_threshold);
  const meter = METER_CLASSES[tone];
  return (
    <li className="grid gap-1.5 border-b border-hairline pb-4 last:border-0 last:pb-0" data-tone={tone}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium [overflow-wrap:anywhere]">{item.item_name}</span>
        <span className="whitespace-nowrap text-sm tabular-nums text-ink-2">{item.stock_quantity} in stock</span>
      </div>
      <div
        role="meter"
        aria-label={`${item.item_name} stock against its low-stock level`}
        aria-valuemin={0}
        aria-valuemax={item.low_stock_threshold}
        aria-valuenow={item.stock_quantity}
        className={`h-2 overflow-hidden rounded ${meter.track}`}
      >
        <div className={`h-full rounded ${meter.fill}`} style={{ width: `${stockPercent(item.stock_quantity, item.low_stock_threshold)}%` }} />
      </div>
      {forecast && context && <ForecastLine forecast={forecast} {...context} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {STATUS_BADGES[tone]}
        {/* Keyed by the saved value, so a save elsewhere (e.g. "apply to all") resets the field. */}
        <ThresholdField key={item.low_stock_threshold} item={item} onSaved={onSaved} />
      </div>
    </li>
  );
}

// The Reorder tab when it's empty: still loading, failed, no orders, or nothing needed.
function noReorderText(forecast: Forecast | null, error: string) {
  if (!forecast) return error || "Working out restock forecasts…";
  if (!forecast.history.from) return "No orders yet, so there's nothing to forecast from.";
  return `Nothing needs reordering to last the next ${forecast.cover_days} days.`;
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
      <Panel title="Stock">
        <Empty>Loading stock…</Empty>
      </Panel>
    );
  }

  const forecasts = new Map(forecast?.items.map((f) => [f.id, f]));
  const inventoryById = new Map(data.inventory.map((item) => [item.id, item]));
  // Soonest to run out first, as the forecast lists them.
  const toReorder = (forecast?.items ?? [])
    .filter((f) => f.reorder_quantity > 0)
    .flatMap((f) => inventoryById.get(f.id) ?? []);
  const items = show === "low" ? data.lowStock : show === "reorder" ? toReorder : data.inventory;
  const filters = [
    { key: "low" as const, label: "Low", count: data.lowStock.length },
    { key: "reorder" as const, label: "Reorder", count: forecast ? toReorder.length : null },
    { key: "all" as const, label: "All items", count: data.inventory.length },
  ];
  const context = forecast ? { lookbackDays: forecast.lookback_days, coverDays: forecast.cover_days } : undefined;
  const emptyText = {
    low: "Everything is above its low-stock level.",
    reorder: noReorderText(forecast, forecastError),
    all: "No tracked items yet. Use “Sync from Shopify”.",
  }[show];

  return (
    <Panel title="Stock">
      <div className="grid max-w-2xl gap-4">
        <div role="group" aria-label="Show" className="flex w-fit gap-1 rounded-lg border border-hairline p-0.5">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={show === f.key}
              onClick={() => setShow(f.key)}
              className={`rounded-md px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                show === f.key ? "bg-ink/8 text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              {f.label} {f.count !== null && <span className="tabular-nums text-ink-2">{f.count}</span>}
            </button>
          ))}
        </div>

        {forecast && data.inventory.length > 0 && <p className="text-sm text-ink-2">{historySummary(forecast.history, shortDate)}</p>}
        {forecastError && (
          <p role="alert" className="text-sm text-error">
            {forecastError}
          </p>
        )}

        {!data.settings.store.connected && data.inventory.length === 0 ? (
          <Empty>
            Connect your store in{" "}
            <Link href="/settings" className="text-accent underline">
              Settings
            </Link>{" "}
            to see your stock here.
          </Empty>
        ) : items.length === 0 ? (
          <Empty>{emptyText}</Empty>
        ) : (
          <ul className="grid gap-4">
            {items.map((item) => (
              <StockRow key={item.id} item={item} forecast={forecasts.get(item.id)} context={context} onSaved={refresh} />
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-2">
          An item counts as low at or below its level. New items start at{" "}
          {data.settings.inventory.default_low_stock_threshold}; change that in{" "}
          <Link href="/settings" className="text-accent underline">
            Settings
          </Link>
          .
          {forecast &&
            ` Sales pace comes from the last ${forecast.lookback_days} days of orders (refunded ones don't count), and reorder amounts last ${forecast.cover_days} days at that pace. A forecast from under 3 orders or under a week of orders is marked as a rough estimate.`}
        </p>
      </div>
    </Panel>
  );
}

export default function StockPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense
      fallback={
        <Panel title="Stock">
          <Empty>Loading stock…</Empty>
        </Panel>
      }
    >
      <StockView />
    </Suspense>
  );
}
