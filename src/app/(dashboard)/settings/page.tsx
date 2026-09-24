"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { apiFetch, UnauthorizedError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { clearSession } from "@/lib/session";
import type { ApiKey, Settings } from "@/lib/types";

const inputClass =
  "min-w-0 flex-1 rounded-lg border border-hairline bg-page px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const primaryButton =
  "rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-progress disabled:opacity-60";
const secondaryButton =
  "rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-progress disabled:opacity-60";

type Message = { text: string; isError: boolean } | null;

function Note({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p role={message.isError ? "alert" : "status"} className={`text-sm ${message.isError ? "text-error" : "text-ink-2"}`}>
      {message.text}
    </p>
  );
}

const json = (body: unknown): RequestInit => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export default function SettingsPage() {
  const { session } = useDashboard();
  const token = session.token;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const [slackUrl, setSlackUrl] = useState("");
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackMessage, setSlackMessage] = useState<Message>(null);

  const [keyName, setKeyName] = useState("Claude Desktop");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyMessage, setKeyMessage] = useState<Message>(null);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // A 401 anywhere means the session ended: back to sign-in, like the rest of the dashboard.
  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await apiFetch<T>(path, token, init);
      } catch (err) {
        if (err instanceof UnauthorizedError) clearSession("expired");
        throw err;
      }
    },
    [token]
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([call<Settings>("/api/settings"), call<{ api_keys: ApiKey[] }>("/api/settings/api-keys")])
      .then(([loaded, { api_keys }]) => {
        if (cancelled) return;
        setSettings(loaded);
        setKeys(api_keys);
      })
      .catch((err: Error) => !cancelled && setLoadError(`Couldn't load settings: ${err.message}`));
    return () => {
      cancelled = true;
    };
  }, [call]);

  async function saveSlack(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSlackBusy(true);
    setSlackMessage(null);
    try {
      await call("/api/settings/slack", { method: "PUT", ...json({ webhook_url: slackUrl.trim() }) });
      setSettings((s) => s && { ...s, slack: { connected: true } });
      setSlackUrl("");
      setSlackMessage({ text: "Saved. New decisions will be posted to that channel.", isError: false });
    } catch (err) {
      setSlackMessage({ text: (err as Error).message, isError: true });
    } finally {
      setSlackBusy(false);
    }
  }

  async function removeSlack() {
    setSlackBusy(true);
    setSlackMessage(null);
    try {
      await call("/api/settings/slack", { method: "DELETE" });
      setSettings((s) => s && { ...s, slack: { connected: false } });
      setSlackMessage({ text: "Removed. Decisions only show on the Decisions tab now.", isError: false });
    } catch (err) {
      setSlackMessage({ text: (err as Error).message, isError: true });
    } finally {
      setSlackBusy(false);
    }
  }

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setKeyBusy(true);
    setKeyMessage(null);
    try {
      const created = await call<{ key: string; api_key: ApiKey }>("/api/settings/api-keys", {
        method: "POST",
        ...json({ name: keyName.trim() }),
      });
      setKeys((list) => [created.api_key, ...(list ?? [])]);
      setNewKey({ name: created.api_key.name, key: created.key });
      setCopied(false);
    } catch (err) {
      setKeyMessage({ text: (err as Error).message, isError: true });
    } finally {
      setKeyBusy(false);
    }
  }

  async function revokeKey(apiKey: ApiKey) {
    if (!window.confirm(`Revoke "${apiKey.name}"? Anything using it stops working right away.`)) return;
    setKeyMessage(null);
    try {
      await call(`/api/settings/api-keys/${apiKey.id}`, { method: "DELETE" });
      setKeys((list) => (list ?? []).filter((k) => k.id !== apiKey.id));
      setKeyMessage({ text: `Revoked "${apiKey.name}".`, isError: false });
    } catch (err) {
      setKeyMessage({ text: (err as Error).message, isError: true });
    }
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.key);
      setCopied(true);
    } catch {
      setKeyMessage({ text: "Couldn't copy automatically. Select the key and copy it.", isError: true });
    }
  }

  if (loadError) {
    return (
      <Panel title="Settings">
        <p role="alert" className="text-sm text-error">{loadError}</p>
      </Panel>
    );
  }
  if (!settings || !keys) {
    return (
      <Panel title="Settings">
        <Empty>Loading settings…</Empty>
      </Panel>
    );
  }

  return (
    <div className="grid gap-4">
      <Panel title="Store">
        {settings.store.connected ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge label="Connected" tone="good" icon="check" />
            <span className="[overflow-wrap:anywhere]">{settings.store.shop_domain}</span>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge label="Not connected" tone="neutral" icon="empty" />
            <span className="text-ink-2">No Shopify store is connected to this account yet.</span>
          </div>
        )}
      </Panel>

      <Panel title="Slack alerts">
        <div className="grid max-w-2xl gap-3">
          <p className="text-sm text-ink-2">
            The agent posts each decision (new orders, low stock) to a Slack channel you choose. Decisions always show on
            the Decisions tab too.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {settings.slack.connected ? (
              <>
                <Badge label="Posting to Slack" tone="good" icon="check" />
                <button type="button" onClick={removeSlack} disabled={slackBusy} className={secondaryButton}>
                  Remove
                </button>
              </>
            ) : (
              <Badge label="Off" tone="neutral" icon="empty" />
            )}
          </div>
          <form onSubmit={saveSlack} className="grid gap-1.5">
            <label htmlFor="slack-url" className="text-sm font-medium">
              {settings.slack.connected ? "Switch to a different webhook URL" : "Slack incoming-webhook URL"}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="slack-url"
                type="url"
                required
                value={slackUrl}
                onChange={(e) => setSlackUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/…"
                autoComplete="off"
                spellCheck={false}
                className={inputClass}
              />
              <button type="submit" disabled={slackBusy} className={primaryButton}>
                {slackBusy ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="text-xs text-ink-2">
              In Slack: Apps › Incoming Webhooks › Add to a channel, then copy the Webhook URL. It&rsquo;s stored encrypted.
            </p>
          </form>
          <Note message={slackMessage} />
        </div>
      </Panel>

      <Panel title="API keys">
        <div className="grid gap-3">
          <p className="max-w-2xl text-sm text-ink-2">
            Let Claude Desktop read your orders and stock through the AI Ops MCP server: put a key in{" "}
            <code className="rounded bg-ink/8 px-1 text-xs">BACKEND_API_KEY</code> in the MCP server&rsquo;s{" "}
            <code className="rounded bg-ink/8 px-1 text-xs">.env</code>. Keys don&rsquo;t expire and can&rsquo;t change
            these settings. Revoke one if it leaks.
          </p>

          {newKey ? (
            <div className="grid max-w-2xl gap-2 rounded-lg border border-border bg-page p-3" data-new-key>
              <p className="text-sm font-medium">
                Copy the key for &ldquo;{newKey.name}&rdquo; now. It won&rsquo;t be shown again.
              </p>
              <code className="select-all rounded border border-hairline bg-surface px-2 py-1.5 text-xs [overflow-wrap:anywhere]">
                {newKey.key}
              </code>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={copyKey} className={primaryButton}>
                  {copied ? "Copied" : "Copy key"}
                </button>
                <button type="button" onClick={() => setNewKey(null)} className={secondaryButton}>
                  Done
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={createKey} className="grid max-w-2xl gap-1.5">
              <label htmlFor="key-name" className="text-sm font-medium">
                New key name
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="key-name"
                  required
                  maxLength={100}
                  value={keyName}
                  onChange={(e) => setKeyName(e.target.value)}
                  className={inputClass}
                />
                <button type="submit" disabled={keyBusy} className={primaryButton}>
                  {keyBusy ? "Creating…" : "Create key"}
                </button>
              </div>
            </form>
          )}
          <Note message={keyMessage} />

          {keys.length === 0 ? (
            <Empty>No API keys yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-hairline text-left text-xs font-semibold text-ink-2">
                    <th scope="col" className="whitespace-nowrap pb-2 pr-3">Name</th>
                    <th scope="col" className="whitespace-nowrap pb-2 pr-3">Key</th>
                    <th scope="col" className="whitespace-nowrap pb-2 pr-3">Created</th>
                    <th scope="col" className="whitespace-nowrap pb-2 pr-3">Last used</th>
                    <th scope="col" className="pb-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-hairline last:border-0" data-api-key={k.id}>
                      <td className="py-2.5 pr-3 font-medium">{k.name}</td>
                      <td className="whitespace-nowrap py-2.5 pr-3 font-mono text-xs text-ink-2">{k.key_prefix}…</td>
                      <td className="whitespace-nowrap py-2.5 pr-3" title={new Date(k.created_at).toLocaleString()}>
                        {new Date(k.created_at).toLocaleDateString()}
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-3 text-ink-2">
                        {k.last_used_at ? timeAgo(k.last_used_at) : "Never"}
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          type="button"
                          onClick={() => revokeKey(k)}
                          className="rounded-lg px-2.5 py-1 text-sm font-medium text-error hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
