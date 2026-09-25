"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDashboard } from "./DashboardProvider";
import { ArrowsClockwiseIcon, GearSixIcon, PackageIcon, RobotIcon, SignOutIcon, SquaresFourIcon, StackIcon } from "./icons";
import { Logo } from "./Logo";
import { accentButton } from "./ui";

// Header (store, last update, sync, sign out), page tabs, and status banner.
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session, data, updatedAt, banner, syncing, sync, logout } = useDashboard();
  // Nothing to sync from until a store is connected (unknown while loading).
  const noStore = data != null && !data.settings.store.connected;

  const tabs = [
    { href: "/overview", label: "Overview", icon: SquaresFourIcon, count: undefined, countLabel: "" },
    { href: "/orders", label: "Orders", icon: PackageIcon, count: data?.pendingCount, countLabel: "need action" },
    { href: "/decisions", label: "Decisions", icon: RobotIcon, count: data?.decisions.length, countLabel: "total" },
    { href: "/stock", label: "Stock", icon: StackIcon, count: data?.lowStock.length, countLabel: "running low" },
    { href: "/settings", label: "Settings", icon: GearSixIcon, count: undefined, countLabel: "" },
  ];

  return (
    <div className="mx-auto grid max-w-6xl gap-5 px-4 pb-12 pt-5 sm:pt-7">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold leading-tight tracking-tight">AI Ops Command Center</h1>
            {session.business_name && <p className="text-sm text-ink-2">{session.business_name}</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {updatedAt && (
            <span className="mr-1 hidden items-center gap-2 font-mono text-xs text-ink-2 sm:flex" aria-live="polite">
              {/* Lime while the data is fresh; grey once a reload has failed (the banner says why). */}
              <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${banner?.isError ? "bg-neutral" : "bg-accent shadow-[0_0_8px_rgb(182_255_46/0.8)]"}`}
              />
              Updated {updatedAt.toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={sync}
            disabled={syncing || noStore}
            title={noStore ? "Connect your store in Settings first" : undefined}
            className={`${accentButton} inline-flex items-center gap-2 ${syncing ? "disabled:cursor-progress" : "disabled:cursor-not-allowed"}`}
          >
            <ArrowsClockwiseIcon aria-hidden="true" weight="bold" className={`size-4 ${syncing ? "motion-safe:animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync from Shopify"}
          </button>
          <button
            type="button"
            onClick={() => logout()}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:bg-ink/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <SignOutIcon aria-hidden="true" className="size-4" />
            Log out
          </button>
        </div>
      </header>

      <nav
        aria-label="Dashboard sections"
        className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:w-fit sm:rounded-xl sm:border sm:border-border sm:bg-surface sm:p-1"
      >
        {tabs.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                active ? "border-accent/25 bg-accent/10 text-accent" : "border-transparent text-ink-2 hover:bg-ink/5 hover:text-ink"
              }`}
            >
              <tab.icon aria-hidden="true" weight={active ? "fill" : "regular"} className="size-4" />
              {tab.label}
              {tab.count != null && (
                <span
                  className={`rounded-full px-1.5 text-xs tabular-nums ${active ? "bg-accent/15" : "bg-ink/8"}`}
                  title={`${tab.count} ${tab.countLabel}`}
                >
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
          className={`rounded-lg border px-3.5 py-2.5 text-sm ${banner.isError ? "border-critical/30 bg-critical/10 text-error" : "border-border bg-surface"}`}
        >
          {banner.text}
        </p>
      )}

      <main>{children}</main>
    </div>
  );
}
