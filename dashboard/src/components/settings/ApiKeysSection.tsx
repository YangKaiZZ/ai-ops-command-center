"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/Panel";
import { Empty } from "@/components/Panel";
import { dangerTextButton, inputClass, Note, primaryButton, secondaryButton, type Message } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { jsonBody, useApi } from "@/lib/useApi";
import type { ApiKey } from "@/lib/types";

// Keys for the AI Ops MCP server in Claude Desktop: created here, shown once, revocable.
export function ApiKeysSection() {
  const call = useApi();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [keyName, setKeyName] = useState("Claude Desktop");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    call<{ api_keys: ApiKey[] }>("/api/settings/api-keys")
      .then(({ api_keys }) => !cancelled && setKeys(api_keys))
      .catch((err: Error) => !cancelled && setMessage({ text: `Couldn't load API keys: ${err.message}`, isError: true }));
    return () => {
      cancelled = true;
    };
  }, [call]);

  async function createKey(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const created = await call<{ key: string; api_key: ApiKey }>("/api/settings/api-keys", {
        method: "POST",
        ...jsonBody({ name: keyName.trim() }),
      });
      setKeys((list) => [created.api_key, ...(list ?? [])]);
      setNewKey({ name: created.api_key.name, key: created.key });
      setCopied(false);
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  async function revokeKey(apiKey: ApiKey) {
    if (!window.confirm(`Revoke "${apiKey.name}"? Anything using it stops working right away.`)) return;
    setMessage(null);
    try {
      await call(`/api/settings/api-keys/${apiKey.id}`, { method: "DELETE" });
      setKeys((list) => (list ?? []).filter((k) => k.id !== apiKey.id));
      setMessage({ text: `Revoked "${apiKey.name}".`, isError: false });
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    }
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.key);
      setCopied(true);
    } catch {
      setMessage({ text: "Couldn't copy automatically. Select the key and copy it.", isError: true });
    }
  }

  return (
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
              <button type="submit" disabled={busy} className={primaryButton}>
                {busy ? "Creating…" : "Create key"}
              </button>
            </div>
          </form>
        )}
        <Note message={message} />

        {keys === null ? null : keys.length === 0 ? (
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
                    <td className="whitespace-nowrap py-2.5 pr-3 text-ink-2">{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</td>
                    <td className="py-2.5 text-right">
                      <button type="button" onClick={() => revokeKey(k)} className={dangerTextButton}>
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
  );
}
