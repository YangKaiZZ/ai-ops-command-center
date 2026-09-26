"use client";

import { useState } from "react";
import { Badge } from "@/components/Badge";
import { Panel } from "@/components/Panel";
import { inputClass, Note, primaryButton, secondaryButton, Subhead, type Message } from "@/components/ui";
import { scopeUses } from "@/lib/shopifyActions";
import { jsonBody, useApi } from "@/lib/useApi";
import type { Settings } from "@/lib/types";

// Connect with Shopify (approve on Shopify, come back here), or paste an Admin
// API token from a custom app. Also shows missing permissions, the auto-hold
// switch, and disconnects.
export function StoreSection({
  settings,
  onChange,
  initialShop,
  flash,
}: {
  settings: Settings;
  onChange: () => Promise<void>;
  initialShop: string;
  flash: Message; // from the redirect back from Shopify
}) {
  const call = useApi();
  const { store, shopify } = settings;
  const [shop, setShop] = useState(initialShop);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(flash);
  const [holdMessage, setHoldMessage] = useState<Message>(null);

  // Saved as soon as it's switched.
  async function setAutoHold(enabled: boolean) {
    setBusy(true);
    setHoldMessage(null);
    try {
      await call("/api/settings/auto-hold", { method: "PUT", ...jsonBody({ enabled }) });
      setHoldMessage({
        text: enabled ? "On: the agent's HOLD now puts the order on hold in Shopify." : "Off: the agent's HOLD is advice only.",
        isError: false,
      });
      await onChange();
    } catch (err) {
      setHoldMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  // Off to Shopify's approval page; Shopify sends the seller back to Settings.
  async function connectWithShopify(shopAddress: string) {
    setBusy(true);
    setMessage(null);
    try {
      const { authorize_url } = await call<{ authorize_url: string }>("/api/shopify/connect", {
        method: "POST",
        ...jsonBody({ shop: shopAddress }),
      });
      window.location.assign(authorize_url);
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
      setBusy(false);
    }
  }

  async function connectWithToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await call<{ missing_scopes: string[] }>("/api/store/connect", {
        method: "POST",
        ...jsonBody({ shop_domain: shop, access_token: token }),
      });
      setToken("");
      const missing = result.missing_scopes.length ? ` The token is missing ${result.missing_scopes.join(", ")}.` : "";
      setMessage({ text: `Connected. Importing your orders and products now.${missing}`, isError: false });
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${store.shop_domain}? This removes the app from the store. Your orders and decisions stay here.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await call("/api/store", { method: "DELETE" });
      setMessage({ text: "Disconnected.", isError: false });
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  if (store.connected) {
    return (
      <Panel title="Store">
        <div className="grid max-w-2xl gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge label="Connected" tone="good" icon="check" />
            <span className="font-medium [overflow-wrap:anywhere]">{store.shop_domain}</span>
          </div>
          {store.missing_scopes.length > 0 && (
            <div className="grid gap-2 rounded-lg border border-border bg-page p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge label="Missing permissions" tone="warning" icon="alert" />
                <span className="font-mono text-xs">{store.missing_scopes.join(", ")}</span>
              </div>
              <p className="text-ink-2">
                Without {store.missing_scopes.length === 1 ? "it" : "these"}, {scopeUses(store.missing_scopes)} can&rsquo;t work.
                {shopify.oauth_available
                  ? ` Reconnect to grant ${store.missing_scopes.length === 1 ? "it" : "them"}.`
                  : ` Give the app ${store.missing_scopes.length === 1 ? "this permission" : "these permissions"} in Shopify, then reconnect.`}
              </p>
              {shopify.oauth_available && (
                <div>
                  <button type="button" onClick={() => connectWithShopify(store.shop_domain!)} disabled={busy} className={primaryButton}>
                    Reconnect with Shopify
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="grid gap-2 border-t border-hairline pt-3 text-sm">
            <Subhead>Holding and fulfilling</Subhead>
            <p className="text-ink-2">
              Each order&rsquo;s page can put it on hold in Shopify, release that hold, or mark it fulfilled.
              {settings.shopify_actions.allowed ? "" : " Your store hasn't allowed this yet: reconnect it (above) to allow it."}
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={settings.shopify_actions.auto_hold}
                onChange={(e) => setAutoHold(e.target.checked)}
                disabled={busy || !settings.shopify_actions.allowed}
                className="mt-0.5 size-4 accent-accent"
              />
              <span>
                When the agent says HOLD, put the order on hold in Shopify
                <span className="block text-xs text-ink-2">
                  With the reason (fraud risk, out of stock, awaiting payment). The alert says it did. The agent never marks anything
                  fulfilled.
                </span>
              </span>
            </label>
            <Note message={holdMessage} />
          </div>
          <div>
            <button type="button" onClick={disconnect} disabled={busy} className={secondaryButton}>
              Disconnect store
            </button>
          </div>
          <Note message={message} />
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Store">
      <div className="grid max-w-2xl gap-3">
        <p className="text-sm text-ink-2">
          Connect your Shopify store to bring in orders and stock. The agent then checks every new order and watches for
          items running low.
        </p>
        {shopify.oauth_available ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              connectWithShopify(shop);
            }}
            className="grid gap-1.5"
          >
            <label htmlFor="shop" className="text-sm font-medium">
              Store address
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="shop"
                required
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                placeholder="my-store.myshopify.com"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? "Opening Shopify…" : "Connect with Shopify"}
              </button>
            </div>
            <p className="text-xs text-ink-2">
              You&rsquo;ll approve access on Shopify to read orders, products and stock, and to hold and fulfill orders when you ask
              (or the agent holds one, if you switch that on).
            </p>
          </form>
        ) : (
          <p className="text-sm text-ink-2">
            &ldquo;Connect with Shopify&rdquo; isn&rsquo;t set up on this server yet, so connect with an Admin API token below.
          </p>
        )}

        <details open={!shopify.oauth_available} className="rounded-lg border border-hairline px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">Use an Admin API token instead</summary>
          <form onSubmit={connectWithToken} className="mt-3 grid gap-2">
            <p className="text-xs text-ink-2">
              For a custom app made in your store&rsquo;s admin (Settings › Apps › Develop apps) with read access to
              orders, products and inventory. To hold and fulfill orders from here, also give it write access to
              merchant-managed fulfillment orders.
            </p>
            <label className="grid gap-1 text-sm font-medium">
              Store address
              <input
                required
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                placeholder="my-store.myshopify.com"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
            </label>
            <label className="grid gap-1 text-sm font-medium">
              Admin API access token
              <input
                required
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="shpat_…"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
            </label>
            <div>
              <button type="submit" disabled={busy} className={secondaryButton}>
                {busy ? "Checking…" : "Connect with token"}
              </button>
            </div>
          </form>
        </details>
        <Note message={message} />
      </div>
    </Panel>
  );
}
