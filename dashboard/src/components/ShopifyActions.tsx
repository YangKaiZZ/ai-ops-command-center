"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { accentButton, inputClass, Note, primaryButton, secondaryButton, Subhead, type Message } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { describeAction, fulfillmentStatus, HOLD_REASONS, itemsToShip } from "@/lib/shopifyActions";
import type { FulfillmentOrderView, HoldReason, ShopifyState } from "@/lib/types";
import { jsonBody, useApi } from "@/lib/useApi";

export type Kind = "hold" | "release" | "fulfill";
const ALL_KINDS: Kind[] = ["hold", "release", "fulfill"];
const fieldClass = `${inputClass} w-full`;
const selectClass =
  "w-full rounded-lg border border-border bg-page px-2.5 py-2 text-sm text-ink transition-colors hover:border-ink-2/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// The order in Shopify: each fulfillment order (one per location it ships
// from) with its status and holds, and what Shopify allows now: put on hold,
// release a hold placed from here, mark as fulfilled. Each opens a short form
// to confirm. Read live from Shopify when the page opens and after each
// action, not on every dashboard refresh.
export function ShopifyActions({ orderId, suggestedReason }: { orderId: number; suggestedReason: HoldReason }) {
  const api = useApi();
  const { refresh } = useDashboard();
  const load = useCallback(() => api<ShopifyState>(`/api/orders/${orderId}/shopify`), [api, orderId]);
  const act = useCallback(
    (kind: Kind, body: Record<string, unknown>) => api<ShopifyState>(`/api/orders/${orderId}/${kind}`, { method: "POST", ...jsonBody(body) }),
    [api, orderId]
  );

  return (
    <Panel title="In Shopify">
      <div id="in-shopify" className="grid scroll-mt-4 gap-3">
        <ShopifyOrderPanel
          load={load}
          act={act}
          suggestedReason={suggestedReason}
          onChanged={refresh} // the order's statuses, here and in the lists
          onLoaded={() => {
            // A link to #in-shopify (from a decision card) lands before this panel has
            // loaded, so the browser can't scroll to it: do that once it's here.
            if (window.location.hash === "#in-shopify") document.getElementById("in-shopify")?.scrollIntoView({ block: "start" });
          }}
        />
      </div>
    </Panel>
  );
}

// The panel's contents, for the order's page and for the confirm page behind
// an alert's link (which reads and acts through the link instead of a
// sign-in, offers only the link's action, and opens its form straight away).
export function ShopifyOrderPanel({
  load: loadState,
  act,
  suggestedReason,
  kinds = ALL_KINDS,
  openAtOnce = false,
  onChanged,
  onLoaded,
}: {
  load: () => Promise<ShopifyState>;
  act: (kind: Kind, body: Record<string, unknown>) => Promise<ShopifyState>;
  suggestedReason: HoldReason;
  kinds?: Kind[];
  openAtOnce?: boolean; // with one kind: open its form if exactly one shipment allows it
  onChanged?: (kind: Kind) => unknown;
  onLoaded?: () => void;
}) {
  const [state, setState] = useState<ShopifyState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [open, setOpen] = useState<{ kind: Kind; foId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  // The confirm page's form opens as soon as the order first arrives.
  const autoOpen = useRef<Kind | null>(openAtOnce && kinds.length === 1 ? kinds[0] : null);

  const load = useCallback(
    () =>
      loadState().then(
        (body) => {
          setState(body);
          setLoadError("");
          const kind = autoOpen.current;
          if (kind && body.fulfillment_orders) {
            autoOpen.current = null;
            const able = body.fulfillment_orders.filter((fo) => can(fo, kind));
            if (able.length === 1) setOpen({ kind, foId: able[0].id });
          }
        },
        (err: Error) => setLoadError(`Couldn't load this order from Shopify: ${err.message}`)
      ),
    [loadState]
  );

  useEffect(() => {
    load();
  }, [load]);

  const loaded = state !== null || loadError !== "";
  useEffect(() => {
    if (loaded) onLoaded?.();
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when it first loads

  async function run(kind: Kind, body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      setState(await act(kind, body));
      setOpen(null);
      setMessage({ text: done, isError: false });
      await onChanged?.(kind);
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
      await load(); // Shopify may have moved on (shipped, held elsewhere)
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (loadError) {
    body = (
      <p role="alert" className="text-sm text-error">
        {loadError}
      </p>
    );
  } else if (!state) {
    body = <Empty>Loading the order from Shopify…</Empty>;
  } else if (!state.fulfillment_orders) {
    body = (
      <Empty>
        {state.note}
        {state.note?.includes("Settings") && (
          <>
            {" "}
            <Link href="/settings" className="text-accent underline">
              Open Settings
            </Link>
          </>
        )}
      </Empty>
    );
  } else if (state.fulfillment_orders.length === 0) {
    body = <Empty>Shopify has nothing to ship for this order.</Empty>;
  } else {
    body = state.fulfillment_orders.map((fo) => (
      <FulfillmentOrderCard
        key={fo.id}
        fo={fo}
        open={open?.foId === fo.id ? open.kind : null}
        setOpen={(kind) => {
          setMessage(null);
          setOpen(kind ? { kind, foId: fo.id } : null);
        }}
        busy={busy}
        suggestedReason={suggestedReason}
        kinds={kinds}
        run={run}
      />
    ));
  }

  return (
    <>
      {body}
      <Note message={message} />
      {state && state.actions.length > 0 && (
        <div className="grid gap-1.5">
          <Subhead>Done from here</Subhead>
          <ul className="grid gap-1 text-sm">
            {state.actions.map((action, i) => {
              const { who, text } = describeAction(action);
              return (
                <li key={i} className={action.ok ? "" : "text-error"}>
                  <time className="text-ink-2" dateTime={action.created_at} title={new Date(action.created_at).toLocaleString()}>
                    {timeAgo(action.created_at)}
                  </time>
                  : {who} {text}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}

// Whether Shopify allows this kind of action on the fulfillment order now.
function can(fo: FulfillmentOrderView, kind: Kind): boolean {
  return kind === "hold" ? fo.can_hold : kind === "release" ? fo.can_release : fo.can_fulfill;
}

function FulfillmentOrderCard({
  fo,
  open,
  setOpen,
  busy,
  suggestedReason,
  kinds,
  run,
}: {
  fo: FulfillmentOrderView;
  open: Kind | null;
  setOpen: (kind: Kind | null) => void;
  busy: boolean;
  suggestedReason: HoldReason;
  kinds: Kind[];
  run: (kind: Kind, body: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const offered = (kind: Kind) => kinds.includes(kind) && can(fo, kind);
  const nothingToDo = !kinds.some(offered);
  return (
    <section aria-label={`Shipment${fo.location ? ` from ${fo.location}` : ""}`} className="grid gap-2.5 rounded-lg border border-hairline p-3.5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge {...fulfillmentStatus(fo.status)} />
        <span>
          {itemsToShip(fo)}
          {fo.location ? ` from ${fo.location}` : ""}
        </span>
      </div>
      {fo.holds.map((hold, i) => (
        <p key={i} className="text-sm">
          On hold: {hold.label}
          {hold.note ? `: ${hold.note}` : ""}{" "}
          <span className="text-ink-2">({hold.ours ? "placed from here" : "placed by another app; release it there"})</span>
        </p>
      ))}
      {!open && !nothingToDo && (
        <div className="flex flex-wrap gap-2">
          {offered("fulfill") && (
            <button type="button" onClick={() => setOpen("fulfill")} className={accentButton}>
              Mark as fulfilled…
            </button>
          )}
          {offered("hold") && (
            <button type="button" onClick={() => setOpen("hold")} className={secondaryButton}>
              Put on hold…
            </button>
          )}
          {offered("release") && (
            <button type="button" onClick={() => setOpen("release")} className={secondaryButton}>
              Release hold…
            </button>
          )}
        </div>
      )}
      {open === "hold" && <HoldForm fo={fo} busy={busy} suggestedReason={suggestedReason} run={run} cancel={() => setOpen(null)} />}
      {open === "release" && (
        <ConfirmBox
          text="Release the hold placed from here? The order can then be shipped."
          confirm="Release hold"
          busy={busy}
          onConfirm={() => run("release", { fulfillment_order_id: fo.id }, "Hold released in Shopify.")}
          cancel={() => setOpen(null)}
        />
      )}
      {open === "fulfill" && <FulfillForm fo={fo} busy={busy} run={run} cancel={() => setOpen(null)} />}
    </section>
  );
}

const formBox = "grid gap-2.5 rounded-lg border border-border bg-page p-3 text-sm";

function FormButtons({ submit, busy, cancel }: { submit: string; busy: boolean; cancel: () => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      <button type="submit" disabled={busy} className={primaryButton}>
        {busy ? "Asking Shopify…" : submit}
      </button>
      <button type="button" onClick={cancel} disabled={busy} className={secondaryButton}>
        Cancel
      </button>
    </div>
  );
}

function ConfirmBox({ text, confirm, busy, onConfirm, cancel }: { text: string; confirm: string; busy: boolean; onConfirm: () => void; cancel: () => void }) {
  return (
    <form
      className={formBox}
      onSubmit={(event) => {
        event.preventDefault();
        onConfirm();
      }}
    >
      <p>{text}</p>
      <FormButtons submit={confirm} busy={busy} cancel={cancel} />
    </form>
  );
}

function HoldForm({
  fo,
  busy,
  suggestedReason,
  run,
  cancel,
}: {
  fo: FulfillmentOrderView;
  busy: boolean;
  suggestedReason: HoldReason;
  run: (kind: Kind, body: Record<string, unknown>, done: string) => Promise<void>;
  cancel: () => void;
}) {
  const [reason, setReason] = useState<HoldReason>(suggestedReason);
  const [note, setNote] = useState("");
  return (
    <form
      className={formBox}
      onSubmit={(event) => {
        event.preventDefault();
        run("hold", { fulfillment_order_id: fo.id, reason, note }, "Put on hold in Shopify.");
      }}
    >
      <p>Nobody can ship it from Shopify until the hold is released.</p>
      <label className="grid gap-1 font-medium">
        Reason
        <select value={reason} onChange={(e) => setReason(e.target.value as HoldReason)} className={selectClass}>
          {HOLD_REASONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 font-medium">
        Note (optional, shown in Shopify)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={255} className={fieldClass} />
      </label>
      <FormButtons submit="Put on hold" busy={busy} cancel={cancel} />
    </form>
  );
}

function FulfillForm({
  fo,
  busy,
  run,
  cancel,
}: {
  fo: FulfillmentOrderView;
  busy: boolean;
  run: (kind: Kind, body: Record<string, unknown>, done: string) => Promise<void>;
  cancel: () => void;
}) {
  const [number, setNumber] = useState("");
  const [company, setCompany] = useState("");
  const [url, setUrl] = useState("");
  const [notify, setNotify] = useState(true);
  const remaining = fo.items.reduce((sum, item) => sum + item.remaining, 0);
  return (
    <form
      className={formBox}
      onSubmit={(event) => {
        event.preventDefault();
        run(
          "fulfill",
          { fulfillment_order_id: fo.id, notify_customer: notify, tracking_number: number, tracking_company: company, tracking_url: url },
          notify ? "Marked as fulfilled in Shopify. The customer gets the shipping details." : "Marked as fulfilled in Shopify."
        );
      }}
    >
      <p>
        Marks {remaining} {remaining === 1 ? "item" : "items"} as shipped in Shopify{fo.location ? ` from ${fo.location}` : ""}. It can&rsquo;t be undone
        from here.
      </p>
      <label className="grid gap-1 font-medium">
        Tracking number (optional)
        <input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={100} autoComplete="off" className={fieldClass} />
      </label>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="grid gap-1 font-medium">
          Carrier (optional)
          <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={100} placeholder="e.g. UPS, DHL" className={fieldClass} />
        </label>
        <label className="grid gap-1 font-medium">
          Tracking link (optional)
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} placeholder="https://" className={fieldClass} />
        </label>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="size-4 accent-accent" />
        Email the customer the shipping details
      </label>
      <FormButtons submit="Mark as fulfilled" busy={busy} cancel={cancel} />
    </form>
  );
}
