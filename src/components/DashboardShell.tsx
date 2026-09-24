"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDashboard } from "./DashboardProvider";

// Header (store, last update, sync, sign out), page tabs, and status banner.
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session, data, updatedAt, banner, syncing, sync, logout } = useDashboard();
  // Nothing to sync from until a store is connected (unknown while loading).
  const noStore = data != null && !data.settings.store.connected;

  const tabs = [
    { href: "/orders", label: "Orders", count: data?.pending.length, countLabel: "need action" },
    { href: "/decisions", label: "Decisions", count: data?.decisions.length, countLabel: "total" },
    { href: "/stock", label: "Stock", count: data?.lowStock.length, countLabel: "running low" },
    { href: "/settings", label: "Settings", count: undefined, countLabel: "" },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-4 px-4 pb-10 pt-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">AI Ops Command Center</h1>
          {session.business_name && <p className="text-sm text-ink-2">{session.business_name}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {updatedAt && (
            <span className="text-sm text-ink-2" aria-live="polite">
              Updated {updatedAt.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={sync}
            disabled={syncing || noStore}
            title={noStore ? "Connect your store in Settings first" : undefined}
            className={`rounded-lg border border-border bg-surface px-3.5 py-1.5 text-sm font-medium hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 ${
              syncing ? "disabled:cursor-progress" : "disabled:cursor-not-allowed"
            }`}
          >
            {syncing ? "Syncing…" : "Sync from Shopify"}
          </button>
          <button
            type="button"
            onClick={() => logout()}
            className="rounded-lg px-3.5 py-1.5 text-sm font-medium hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Log out
          </button>
        </div>
      </header>

      <nav aria-label="Dashboard sections" className="flex flex-wrap gap-1 border-b border-hairline">
        {tabs.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${
                active ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"
              }`}
            >
              {tab.label}
              {tab.count != null && (
                <span className="rounded-full bg-ink/8 px-2 text-xs tabular-nums" title={`${tab.count} ${tab.countLabel}`}>
                  {tab.count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {banner && (
        <p
          role="status"
          className={`rounded-lg border border-border bg-surface px-3.5 py-2.5 text-sm ${banner.isError ? "text-error" : ""}`}
        >
          {banner.text}
        </p>
      )}

      <main>{children}</main>
    </div>
  );
}
