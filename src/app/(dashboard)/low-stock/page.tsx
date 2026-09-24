"use client";

import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { stockPercent, stockTone } from "@/lib/format";
import type { LowStockItem } from "@/lib/types";

// Fill = the status color; track = a lighter step of the same hue.
const METER_CLASSES = {
  critical: { track: "bg-critical/20", fill: "bg-critical" },
  warning: { track: "bg-warning/25", fill: "bg-warning" },
  good: { track: "bg-good/20", fill: "bg-good" },
} as const;

function StockRow({ item }: { item: LowStockItem }) {
  const tone = stockTone(item.stock_quantity, item.low_stock_threshold);
  const meter = METER_CLASSES[tone];
  return (
    <li className="grid gap-1.5" data-tone={tone}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium [overflow-wrap:anywhere]">{item.item_name}</span>
        <span className="whitespace-nowrap text-sm tabular-nums text-ink-2">
          {item.stock_quantity} of {item.low_stock_threshold}
        </span>
      </div>
      <div
        role="meter"
        aria-label={`${item.item_name} stock`}
        aria-valuemin={0}
        aria-valuemax={item.low_stock_threshold}
        aria-valuenow={item.stock_quantity}
        className={`h-2 overflow-hidden rounded ${meter.track}`}
      >
        <div className={`h-full rounded ${meter.fill}`} style={{ width: `${stockPercent(item.stock_quantity, item.low_stock_threshold)}%` }} />
      </div>
      <div>
        {tone === "critical" ? (
          <Badge label="Out of stock" tone="critical" icon="empty" />
        ) : (
          <Badge label="Low" tone="warning" icon="alert" />
        )}
      </div>
    </li>
  );
}

export default function LowStockPage() {
  const { data } = useDashboard();

  return (
    <Panel title="Low stock">
      {!data ? (
        <Empty>Loading stock…</Empty>
      ) : data.lowStock.length === 0 ? (
        <Empty>Everything is above its threshold.</Empty>
      ) : (
        <ul className="grid max-w-2xl gap-4">
          {data.lowStock.map((item) => (
            <StockRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
