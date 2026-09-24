"use client";

import Link from "next/link";
import { useState } from "react";
import { Panel } from "@/components/Panel";
import { inputClass, Note, primaryButton, type Message } from "@/components/ui";
import { jsonBody, useApi } from "@/lib/useApi";
import type { Settings } from "@/lib/types";

// The low-stock level new items start with. Per-item levels are on the Stock tab.
export function StockDefaultsSection({ settings, onChange }: { settings: Settings; onChange: () => Promise<void> }) {
  const call = useApi();
  const [value, setValue] = useState(String(settings.inventory.default_low_stock_threshold));
  const [applyToAll, setApplyToAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await call<{ items_updated: number }>("/api/settings/inventory", {
        method: "PUT",
        ...jsonBody({ default_low_stock_threshold: Number(value), apply_to_all: applyToAll }),
      });
      setMessage({
        text: applyToAll ? `Saved, and applied to ${result.items_updated} item${result.items_updated === 1 ? "" : "s"}.` : "Saved for new items.",
        isError: false,
      });
      setApplyToAll(false);
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Low-stock level">
      <form onSubmit={save} className="grid max-w-2xl gap-2">
        <label htmlFor="default-threshold" className="text-sm font-medium">
          New items count as low at or below
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id="default-threshold"
            type="number"
            required
            min={0}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className={`${inputClass} max-w-28 flex-none tabular-nums`}
          />
          <span className="text-sm text-ink-2">units</span>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} className="size-4 accent-accent" />
          Also apply to every item I already have (replaces levels set per item)
        </label>
        <p className="text-xs text-ink-2">
          Set a different level for one item on the{" "}
          <Link href="/stock" className="text-accent underline">
            Stock
          </Link>{" "}
          tab.
        </p>
        <Note message={message} />
      </form>
    </Panel>
  );
}
