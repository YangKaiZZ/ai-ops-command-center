"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDashboard } from "./DashboardProvider";
import {
  ArrowsClockwiseIcon,
  ChatCircleDotsIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  ReceiptIcon,
  SignOutIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  SquaresFourIcon,
  type Icon,
} from "./icons";
import { DemoBanner } from "./DemoBanner";
import { Logo } from "./Logo";
import { accentButton, focusRing } from "./ui";
import { filterDecisions } from "@/lib/feedback";
import { timeAgo } from "@/lib/format";

type NavItem = { href: string; label: string; icon: Icon; count?: number; countLabel?: string };

function NavLink({ item, active, compact = false }: { item: NavItem; active: boolean; compact?: boolean }) {
  const Glyph = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={`flex shrink-0 items-center gap-3 whitespace-nowrap rounded-lg font-medium transition-colors ${focusRing} ${
        compact ? "px-3 py-1.5 text-[13px]" : "px-2.5 py-[9px] text-sm"
      } ${active ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-field hover:text-ink"}`}
    >
      <Glyph aria-hidden="true" weight={active ? "fill" : "regular"} className="size-[18px] shrink-0" />
      {item.label}
      {item.count != null && item.count > 0 && (
        <span
          className={`${compact ? "" : "ml-auto"} rounded-full px-[7px] py-px font-mono text-[11px] tabular-nums ${active ? "bg-accent/15" : "bg-line text-ink-soft"}`}
          title={`${item.count} ${item.countLabel ?? ""}`}
        >
          {item.count}
        </span>
      )}
    </Link>
  );
}

// Jump to the Orders page searched for a number or customer. Ctrl+K (or ⌘K) focuses it.
function SearchBox() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <form
      role="search"
      aria-label="Search orders"
      onSubmit={(event) => {
        event.preventDefault();
        const q = text.trim();
        router.push(q ? `/orders?q=${encodeURIComponent(q)}` : "/orders");
        setText("");
        input.current?.blur();
      }}
      className="hidden w-[300px] items-center gap-2 rounded-[9px] border border-border bg-field px-3 py-2 text-[13px] text-ink-2 transition-colors focus-within:border-accent/50 md:flex"
    >
      <MagnifyingGlassIcon aria-hidden="true" className="size-[15px] shrink-0" />
      <input
        ref={input}
        type="search"
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={100}
        placeholder="Search orders or customers…"
        aria-label="Search orders by number or customer"
        className="min-w-0 flex-1 bg-transparent text-ink placeholder:text-ink-2 focus:outline-none"
      />
      <kbd className="rounded-[5px] border border-border px-1.5 font-sans text-[11px] text-ink-2">Ctrl K</kbd>
    </form>
  );
}

// The frame around every signed-in page: the side navigation (a tab row on
// phones), the top bar (store, search, last update, sync, sign out), and
// the demo and status banners.
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { session, data, updatedAt, banner, syncing, sync, logout } = useDashboard();
  // Nothing to sync from until a store is connected (unknown while loading).
  const noStore = data != null && !data.settings.store.connected;
  const store = data?.settings.store;
  const unrated = data ? filterDecisions(data.decisions, "unrated").length : undefined;
  const lastCall = data?.decisions[0]?.created_at;
  const name = data?.settings.business_name || session.business_name || "";

  const main: NavItem[] = [
    { href: "/overview", label: "Overview", icon: SquaresFourIcon },
    { href: "/orders", label: "Orders", icon: ReceiptIcon, count: data?.pendingCount, countLabel: "need action" },
    { href: "/stock", label: "Stock", icon: CubeIcon, count: data?.lowStock.length, countLabel: "running low" },
    { href: "/decisions", label: "Decisions", icon: SparkleIcon, count: unrated, countLabel: "not rated yet" },
    { href: "/chat", label: "Chat", icon: ChatCircleDotsIcon },
  ];
  const account: NavItem = { href: "/settings", label: "Settings", icon: SlidersHorizontalIcon };
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col gap-0.5 border-r border-line bg-sidebar px-3.5 py-5 lg:flex">
        <Link href="/overview" className={`mb-5 flex items-center gap-2.5 rounded-lg px-2 py-1 ${focusRing}`}>
          <Logo />
          <span>
            <span className="block text-[15px] font-bold leading-tight">AI Ops</span>
            <span className="block text-[11px] text-ink-2">Command Center</span>
          </span>
        </Link>
        <nav aria-label="Dashboard sections" className="flex flex-col gap-0.5">
          {main.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(item.href)} />
          ))}
          <span className="px-2.5 pb-1.5 pt-3.5 text-[11px] uppercase tracking-[0.08em] text-ink-2">Account</span>
          <NavLink item={account} active={isActive(account.href)} />
        </nav>
        {data && (
          <div className="mt-auto grid gap-1.5 rounded-[10px] border border-line bg-field/60 p-3">
            <p className="flex items-center gap-2 text-[13px] font-semibold">
              <span
                aria-hidden="true"
                className={`size-2 rounded-full ${store?.connected ? "bg-accent shadow-[0_0_0_3px_rgb(182_255_46/0.15)]" : "bg-neutral"}`}
              />
              {data.settings.demo ? "Demo store" : store?.connected ? "Store connected" : "No store connected"}
            </p>
            <p className="text-xs text-ink-2">{lastCall ? `Agent's last call ${timeAgo(lastCall)}` : "No agent calls yet"}</p>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-page/90 backdrop-blur">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-8">
            <div className="flex min-w-0 items-center gap-2.5 text-[13px] text-ink-soft">
              <span className="lg:hidden">
                <Logo />
              </span>
              {store?.connected ? (
                <>
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
                  <span className="truncate font-mono" title="Your Shopify store">
                    {store.shop_domain}
                  </span>
                </>
              ) : data ? (
                <Link href="/settings" className={`truncate text-ink-2 hover:text-ink ${focusRing}`}>
                  {data.settings.demo ? "Sample store" : "No store connected"}
                </Link>
              ) : null}
            </div>
            <div className="flex items-center gap-2.5 sm:gap-3.5">
              <SearchBox />
              {updatedAt && (
                <span className="hidden items-center gap-2 text-[12.5px] text-ink-2 xl:flex" aria-live="polite">
                  {/* Lime while the data is fresh; grey once a reload has failed (the banner says why). */}
                  <span aria-hidden="true" className={`size-1.5 rounded-full ${banner?.isError ? "bg-neutral" : "bg-accent"}`} />
                  Updated {updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              )}
              <button
                type="button"
                onClick={sync}
                disabled={syncing || noStore}
                title={noStore ? "Connect your store in Settings first" : "Bring in the latest orders and stock from Shopify"}
                className={`${accentButton} ${syncing ? "disabled:cursor-progress" : "disabled:cursor-not-allowed"}`}
              >
                <ArrowsClockwiseIcon aria-hidden="true" weight="bold" className={`size-4 ${syncing ? "motion-safe:animate-spin" : ""}`} />
                <span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync now"}</span>
                <span className="sr-only sm:hidden">{syncing ? "Syncing" : "Sync now"}</span>
              </button>
              {name && (
                <span
                  aria-hidden="true"
                  title={name}
                  className="hidden size-8 place-items-center rounded-full bg-hairline text-[13px] font-bold uppercase sm:grid"
                >
                  {name.trim().charAt(0)}
                </span>
              )}
              <button
                type="button"
                onClick={() => logout()}
                title="Log out"
                className={`inline-flex items-center gap-2 rounded-lg p-2 text-ink-2 transition-colors hover:bg-field hover:text-ink ${focusRing}`}
              >
                <SignOutIcon aria-hidden="true" className="size-[18px]" />
                <span className="sr-only">Log out</span>
              </button>
            </div>
          </div>
          <nav aria-label="Dashboard sections" className="flex gap-1 overflow-x-auto px-4 pb-2.5 [scrollbar-width:none] lg:hidden">
            {[...main, account].map((item) => (
              <NavLink key={item.href} item={item} active={isActive(item.href)} compact />
            ))}
          </nav>
        </header>

        <main className="mx-auto grid w-full max-w-[1400px] flex-1 content-start gap-5 px-4 pb-12 pt-6 sm:px-8">
          {data?.settings.demo && <DemoBanner demo={data.settings.demo} />}
          {banner && (
            <p
              role="status"
              className={`rounded-lg border px-3.5 py-2.5 text-sm ${banner.isError ? "border-critical/30 bg-critical/10 text-error" : "border-border bg-surface"}`}
            >
              {banner.text}
            </p>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
