"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { secondaryButton } from "@/components/ui";
import { stockPercent, stockTone } from "@/lib/format";
import { jsonBody, useApi } from "@/lib/useApi";
import type { InventoryItem } from "@/lib/types";

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

function StockRow({ item, onSaved }: { item: InventoryItem; onSaved: () => Promise<void> }) {
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        {STATUS_BADGES[tone]}
        {/* Keyed by the saved value, so a save elsewhere (e.g. "apply to all") resets the field. */}
        <ThresholdField key={item.low_stock_threshold} item={item} onSaved={onSaved} />
      </div>
    </li>
  );
}

export default function StockPage() {
  const { data, refresh } = useDashboard();
  const [show, setShow] = useState<"low" | "all">("low");

  if (!data) {
    return (
      <Panel title="Stock">
        <Empty>Loading stock…</Empty>
      </Panel>
    );
  }

  const items = show === "low" ? data.lowStock : data.inventory;
  const filters = [
    { key: "low" as const, label: "Low", count: data.lowStock.length },
    { key: "all" as const, label: "All items", count: data.inventory.length },
  ];

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
              {f.label} <span className="tabular-nums text-ink-2">{f.count}</span>
            </button>
          ))}
        </div>

        {!data.settings.store.connected && data.inventory.length === 0 ? (
          <Empty>
            Connect your store in{" "}
            <Link href="/settings" className="text-accent underline">
              Settings
            </Link>{" "}
            to see your stock here.
          </Empty>
        ) : items.length === 0 ? (
          <Empty>{show === "low" ? "Everything is above its low-stock level." : "No tracked items yet. Use “Sync from Shopify”."}</Empty>
        ) : (
          <ul className="grid gap-4">
            {items.map((item) => (
              <StockRow key={item.id} item={item} onSaved={refresh} />
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
        </p>
      </div>
    </Panel>
  );
}
