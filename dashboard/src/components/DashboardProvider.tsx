"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, UnauthorizedError } from "@/lib/api";
import { clearSession, loadSession, takeSignOutReason, useSession } from "@/lib/session";
import type { Decision, InventoryItem, Ratings, Session, Settings } from "@/lib/types";

const REFRESH_MS = 30_000;

type DashboardData = {
  pendingCount: number; // orders that need action; the Orders page loads its own page of orders
  inventory: InventoryItem[]; // every tracked item, low ones first
  lowStock: InventoryItem[];
  decisions: Decision[]; // the latest 200
  ratings: Ratings; // over every decision, not just those 200
  settings: Settings; // store connection and alert channels, for setup prompts
};

type Banner = { text: string; isError: boolean } | null;

type DashboardContextValue = {
  session: Session;
  data: DashboardData | null;
  updatedAt: Date | null;
  banner: Banner;
  syncing: boolean;
  sync: () => Promise<void>;
  refresh: () => Promise<void>; // reload everything now, e.g. after changing a setting
  logout: () => void;
};

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const value = useContext(DashboardContext);
  if (!value) throw new Error("useDashboard must be used inside <DashboardProvider>");
  return value;
}

// Owns the session check, the data for every page, the 30s poll, and sync.
export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const session = useSession();
  const token = session?.token;
  const [data, setData] = useState<DashboardData | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [syncing, setSyncing] = useState(false);

  // No session (never signed in, logged out, or expired) -> sign-in page.
  // Re-checks storage: during hydration `session` is briefly null even when signed in.
  useEffect(() => {
    if (!session && !loadSession()) {
      router.replace(takeSignOutReason() === "expired" ? "/login?expired=1" : "/login");
    }
  }, [session, router]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [pending, { items }, { decisions, ratings }, settings] = await Promise.all([
        apiFetch<{ total: number }>("/api/orders/pending?limit=1", token),
        apiFetch<{ items: InventoryItem[] }>("/api/inventory", token),
        apiFetch<{ decisions: Decision[]; ratings: Ratings }>("/api/decisions?limit=200", token),
        apiFetch<Settings>("/api/settings", token),
      ]);
      const lowStock = items.filter((item) => item.is_low);
      setData({ pendingCount: pending.total, inventory: items, lowStock, decisions, ratings, settings });
      setUpdatedAt(new Date());
      setBanner((b) => (b?.isError ? null : b));
    } catch (err) {
      if (err instanceof UnauthorizedError) return clearSession("expired");
      setBanner({ text: `Couldn't load the dashboard: ${(err as Error).message}`, isError: true });
    }
  }, [token]);

  // Load now, then poll every 30s while signed in.
  useEffect(() => {
    if (!token) return;
    // Polling an external API is what effects are for; refresh() only sets state
    // after the responses arrive, never synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [token, refresh]);

  const sync = useCallback(async () => {
    if (!token) return;
    setSyncing(true);
    try {
      // Note: an inventory sync can trigger the low-stock agent (and a Slack post).
      const [orders, inventory] = await Promise.all([
        apiFetch<{ message: string }>("/api/orders/sync", token, { method: "POST" }),
        apiFetch<{ message: string }>("/api/inventory/sync", token, { method: "POST" }),
      ]);
      setBanner({ text: `${orders.message}. ${inventory.message}.`, isError: false });
      await refresh();
    } catch (err) {
      if (err instanceof UnauthorizedError) return clearSession("expired");
      setBanner({ text: `Sync failed: ${(err as Error).message}`, isError: true });
    } finally {
      setSyncing(false);
    }
  }, [token, refresh]);

  const logout = useCallback(() => clearSession(), []);

  const value = useMemo(
    () => (session ? { session, data, updatedAt, banner, syncing, sync, refresh, logout } : null),
    [session, data, updatedAt, banner, syncing, sync, refresh, logout]
  );

  if (!value) return null; // hydrating, or on the way to /login
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}
