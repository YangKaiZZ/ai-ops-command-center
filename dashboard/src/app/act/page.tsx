"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { Logo } from "@/components/Logo";
import { ShopifyOrderPanel, type Kind } from "@/components/ShopifyActions";
import { formatMoney } from "@/lib/format";
import type { ActionLink, ShopifyState } from "@/lib/types";

// The page behind "Hold in Shopify" / "Mark fulfilled" in Slack and email
// alerts: no sign-in, the link's signed token names the one order and the one
// action it allows. It shows the order as Shopify has it now and opens the
// same short form as the order's page; nothing happens until it's submitted,
// because mail scanners open links by themselves.

const TITLES: Record<ActionLink["action"], string> = { hold: "Put an order on hold", fulfill: "Mark an order fulfilled" };
const CANNOT: Record<ActionLink["action"], string> = {
  hold: "Shopify won't put this order on hold now: it may be shipped already, or already on hold from here. Here's where it stands.",
  fulfill: "Shopify won't mark this order fulfilled now: it may be on hold, or shipped already. Here's where it stands.",
};

async function linkRequest<T>(token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/act/${encodeURIComponent(token)}`, { ...init, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

function ActForm() {
  const token = useSearchParams().get("t") ?? "";
  const [link, setLink] = useState<ActionLink | null>(null);
  const [loadError, setLoadError] = useState("");
  const [done, setDone] = useState(false);
  // The panel's first load is the state this page already fetched, so
  // opening the link asks Shopify once, not twice.
  const firstState = useRef<ShopifyState | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    linkRequest<ActionLink>(token)
      .then((body) => {
        if (cancelled) return;
        firstState.current = body.state;
        setLink(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const load = useCallback(() => {
    const first = firstState.current;
    firstState.current = null;
    return first ? Promise.resolve(first) : linkRequest<ActionLink>(token).then((body) => body.state);
  }, [token]);
  const act = useCallback(
    (kind: Kind, body: Record<string, unknown>) =>
      linkRequest<ShopifyState>(token, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    [token]
  );
  const kinds = useMemo<Kind[]>(() => (link ? [link.action] : []), [link]);

  const error = token ? loadError : "This link isn't valid.";
  const card = "glow relative grid w-full max-w-lg gap-4 rounded-xl border border-border bg-surface p-7";
  const header = (
    <div className="flex items-center gap-3">
      <Logo />
      <h1 className="text-lg font-semibold tracking-tight">{link ? TITLES[link.action] : "In Shopify"}</h1>
    </div>
  );

  if (error || !link) {
    return (
      <div className={card}>
        {header}
        {error ? (
          <>
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
            <Link href="/orders" className="text-sm font-medium text-accent underline">
              Open the Orders page
            </Link>
          </>
        ) : (
          <p className="text-sm text-ink-2">Loading the order from Shopify…</p>
        )}
      </div>
    );
  }

  const { order, state } = link;
  const can = (fulfillmentOrders: ShopifyState["fulfillment_orders"]) =>
    (fulfillmentOrders ?? []).some((fo) => (link.action === "hold" ? fo.can_hold : fo.can_fulfill));
  const orderUrl = `/orders/${order.id}#in-shopify`;

  return (
    <div className={card}>
      {header}
      {link.business_name && <p className="-mt-2 text-sm text-ink-2">For {link.business_name}</p>}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-page/60 px-3.5 py-3 text-sm">
        <span className="font-semibold">Order {order.order_number ?? order.id}</span>
        <span className="tabular-nums">{formatMoney(order.total_amount)}</span>
        {order.financial_status && <span className="text-ink-2">· {order.financial_status.replace(/_/g, " ")}</span>}
        {order.flagged && <Badge label="Flagged for fraud" tone="critical" icon="risk" />}
      </div>

      {!done && state.fulfillment_orders && !can(state.fulfillment_orders) && <p className="text-sm">{CANNOT[link.action]}</p>}

      <div className="grid gap-3">
        <ShopifyOrderPanel
          load={load}
          act={act}
          kinds={kinds}
          openAtOnce
          suggestedReason={order.suggested_reason}
          onChanged={() => setDone(true)}
        />
      </div>

      <p className="text-xs text-ink-2">
        {done ? "Done. " : ""}
        <Link href={orderUrl} className="font-medium text-accent underline">
          Open the order in the dashboard
        </Link>{" "}
        for everything else (release a hold, other shipments, the agent&rsquo;s reasoning). This link works until{" "}
        {new Date(link.expires_at).toLocaleDateString()}.
      </p>
    </div>
  );
}

export default function ActPage() {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense>
        <ActForm />
      </Suspense>
    </main>
  );
}
