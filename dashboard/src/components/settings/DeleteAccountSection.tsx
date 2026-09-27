"use client";

import { useState } from "react";
import { Panel } from "@/components/Panel";
import { inputClass, Note, secondaryButton, type Message } from "@/components/ui";
import { storageKey } from "@/lib/chat";
import { clearSession } from "@/lib/session";
import { jsonBody, useApi } from "@/lib/useApi";
import { useDashboard } from "@/components/DashboardProvider";

const dangerButton =
  "rounded-lg border border-critical/40 bg-critical/15 px-3.5 py-2 text-sm font-semibold text-error transition-colors hover:bg-critical/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-progress disabled:opacity-60";

// Deletes the account and everything kept for it, after asking for the
// password again. Not shown in the demo (it deletes itself).
export function DeleteAccountSection() {
  const { session } = useDashboard();
  const call = useApi();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function remove(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDeleting(true);
    setMessage(null);
    try {
      await call("/api/settings/account", { method: "DELETE", ...jsonBody({ password }) });
      try {
        sessionStorage.removeItem(storageKey(session.token)); // the chat kept in this tab
      } catch {
        // Nothing stored.
      }
      clearSession("deleted");
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
      setDeleting(false);
    }
  }

  return (
    <Panel title="Delete account">
      <div className="grid max-w-2xl gap-3">
        <p className="text-sm text-ink-2">
          Deletes your account and everything kept for it: orders, stock, the agent&rsquo;s decisions and your ratings, alert settings and
          API keys. The app is also uninstalled from your Shopify store. This can&rsquo;t be undone.
        </p>
        {!open ? (
          <button type="button" onClick={() => setOpen(true)} className={`${secondaryButton} w-fit text-error`}>
            Delete account…
          </button>
        ) : (
          <form onSubmit={remove} className="grid gap-2">
            <label htmlFor="delete-password" className="text-sm font-medium">
              Enter your password to confirm
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={`${inputClass} max-w-xs`}
              />
              <button type="submit" disabled={deleting || !password} className={dangerButton}>
                {deleting ? "Deleting…" : "Delete my account"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPassword("");
                  setMessage(null);
                }}
                disabled={deleting}
                className={secondaryButton}
              >
                Cancel
              </button>
            </div>
            <Note message={message} />
          </form>
        )}
      </div>
    </Panel>
  );
}
