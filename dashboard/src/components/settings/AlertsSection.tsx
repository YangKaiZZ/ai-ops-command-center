"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/Badge";
import { Panel } from "@/components/Panel";
import { inputClass, Note, primaryButton, secondaryButton, Subhead, type Message } from "@/components/ui";
import { jsonBody, useApi } from "@/lib/useApi";
import type { AlertResult, Settings } from "@/lib/types";

const CHANNEL_NAMES: Record<AlertResult["channel"], string> = { slack: "Slack", email: "Email", telegram: "Telegram" };

function OnOff({ on, label }: { on: boolean; label: string }) {
  return on ? <Badge label={label} tone="good" icon="check" /> : <Badge label="Off" tone="neutral" icon="empty" />;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2 border-t border-hairline pt-3 first:border-0 first:pt-0">{children}</div>;
}

// Where the agent's decisions go besides the dashboard: Slack, email, Telegram.
export function AlertsSection({ settings, onChange }: { settings: Settings; onChange: () => Promise<void> }) {
  const call = useApi();
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<Message>(null);
  const anyOn = settings.slack.connected || Boolean(settings.email_alerts.address) || settings.telegram.connected;

  async function sendTest() {
    setTesting(true);
    setTestMessage(null);
    try {
      const { results } = await call<{ results: AlertResult[] }>("/api/settings/test-alert", { method: "POST" });
      const text = results.map((r) => `${CHANNEL_NAMES[r.channel]}: ${r.ok ? "sent" : `failed (${r.error})`}`).join(" · ");
      setTestMessage({ text, isError: results.some((r) => !r.ok) });
    } catch (err) {
      setTestMessage({ text: (err as Error).message, isError: true });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Panel title="Alerts">
      <div className="grid max-w-2xl gap-3">
        <p className="text-sm text-ink-2">
          The agent sends each decision (new orders, items running low) to every channel you turn on, with Right call and
          Wrong call buttons to rate it: one tap in Telegram, a short page from Slack or email. Decisions always show on the
          Decisions tab too.
        </p>
        <SlackRow connected={settings.slack.connected} onChange={onChange} />
        <EmailRow alerts={settings.email_alerts} accountEmail={settings.email} onChange={onChange} />
        <TelegramRow telegram={settings.telegram} onChange={onChange} />
        <Row>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={sendTest} disabled={testing || !anyOn} className={secondaryButton}>
              {testing ? "Sending…" : "Send a test alert"}
            </button>
            {!anyOn && <span className="text-sm text-ink-2">Turn on a channel first.</span>}
          </div>
          <Note message={testMessage} />
        </Row>
      </div>
    </Panel>
  );
}

function SlackRow({ connected, onChange }: { connected: boolean; onChange: () => Promise<void> }) {
  const call = useApi();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await call("/api/settings/slack", { method: "PUT", ...jsonBody({ webhook_url: url.trim() }) });
      setUrl("");
      setMessage({ text: "Saved. New decisions will be posted to that channel.", isError: false });
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      await call("/api/settings/slack", { method: "DELETE" });
      setMessage({ text: "Slack alerts turned off.", isError: false });
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row>
      <div className="flex flex-wrap items-center gap-2">
        <Subhead>Slack</Subhead>
        <OnOff on={connected} label="Posting to Slack" />
        {connected && (
          <button type="button" onClick={remove} disabled={busy} className={secondaryButton}>
            Remove
          </button>
        )}
      </div>
      <form onSubmit={save} className="grid gap-1.5">
        <label htmlFor="slack-url" className="text-sm font-medium">
          {connected ? "Switch to a different webhook URL" : "Slack incoming-webhook URL"}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="slack-url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
          />
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-xs text-ink-2">
          In Slack: Apps › Incoming Webhooks › Add to a channel, then copy the Webhook URL. It&rsquo;s stored encrypted.
        </p>
      </form>
      <Note message={message} />
    </Row>
  );
}

function EmailRow({
  alerts,
  accountEmail,
  onChange,
}: {
  alerts: Settings["email_alerts"];
  accountEmail: string;
  onChange: () => Promise<void>;
}) {
  const call = useApi();
  const [address, setAddress] = useState(accountEmail);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ text: success, isError: false });
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  const sendCode = (to: string) =>
    run(() => call("/api/settings/email", { method: "PUT", ...jsonBody({ email: to }) }), `Code sent to ${to.trim().toLowerCase()}.`);
  const verify = () =>
    run(async () => {
      await call("/api/settings/email/verify", { method: "POST", ...jsonBody({ code }) });
      setCode("");
    }, "Email alerts are on.");
  const remove = () => run(() => call("/api/settings/email", { method: "DELETE" }), "Email alerts turned off.");

  return (
    <Row>
      <div className="flex flex-wrap items-center gap-2">
        <Subhead>Email</Subhead>
        <OnOff on={Boolean(alerts.address)} label={`Sending to ${alerts.address}`} />
        {alerts.address && !alerts.pending && (
          <button type="button" onClick={remove} disabled={busy} className={secondaryButton}>
            Remove
          </button>
        )}
      </div>

      {!alerts.available ? (
        <p className="text-sm text-ink-2">Email alerts aren&rsquo;t set up on this server yet.</p>
      ) : alerts.pending ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            verify();
          }}
          className="grid gap-1.5"
        >
          <label htmlFor="email-code" className="text-sm font-medium">
            Enter the 6-digit code sent to {alerts.pending}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="email-code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className={`${inputClass} max-w-40 font-mono tracking-widest`}
            />
            <button type="submit" disabled={busy} className={primaryButton}>
              {busy ? "Checking…" : "Confirm"}
            </button>
            <button type="button" onClick={() => sendCode(alerts.pending!)} disabled={busy} className={secondaryButton}>
              Send a new code
            </button>
            <button type="button" onClick={remove} disabled={busy} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendCode(address);
          }}
          className="grid gap-1.5"
        >
          <label htmlFor="alert-email" className="text-sm font-medium">
            {alerts.address ? "Send alerts to a different address" : "Send alerts to"}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id="alert-email"
              type="email"
              required
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              autoComplete="email"
              className={inputClass}
            />
            <button type="submit" disabled={busy} className={primaryButton}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </div>
          <p className="text-xs text-ink-2">We email a code to confirm the address before any alerts go there.</p>
        </form>
      )}
      <Note message={message} />
    </Row>
  );
}

const LINK_POLL_MS = 3000;
const LINK_WINDOW_MS = 15 * 60 * 1000;

function TelegramRow({ telegram, onChange }: { telegram: Settings["telegram"]; onChange: () => Promise<void> }) {
  const call = useApi();
  const [link, setLink] = useState<{ url: string; until: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  // While a link is open, check every few seconds whether the seller pressed Start.
  useEffect(() => {
    if (!link || telegram.connected) return;
    const timer = setInterval(() => {
      if (Date.now() > link.until) {
        setLink(null);
        setMessage({ text: "That link expired. Get a new one.", isError: true });
        return;
      }
      onChange().catch(() => {});
    }, LINK_POLL_MS);
    return () => clearInterval(timer);
  }, [link, telegram.connected, onChange]);

  async function connect() {
    setBusy(true);
    setMessage(null);
    try {
      const { url } = await call<{ url: string }>("/api/settings/telegram", { method: "POST" });
      setLink({ url, until: Date.now() + LINK_WINDOW_MS });
      window.open(url, "_blank", "noopener");
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setMessage(null);
    try {
      await call("/api/settings/telegram", { method: "DELETE" });
      setMessage({ text: "Telegram alerts turned off.", isError: false });
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  const waiting = link && !telegram.connected;
  return (
    <Row>
      <div className="flex flex-wrap items-center gap-2">
        <Subhead>Telegram</Subhead>
        <OnOff on={telegram.connected} label="Sending to Telegram" />
        {telegram.connected && (
          <button type="button" onClick={disconnect} disabled={busy} className={secondaryButton}>
            Remove
          </button>
        )}
      </div>
      {!telegram.available ? (
        <p className="text-sm text-ink-2">Telegram alerts aren&rsquo;t set up on this server yet.</p>
      ) : !telegram.connected && (
        <div className="grid gap-1.5">
          <div>
            <button type="button" onClick={connect} disabled={busy} className={primaryButton}>
              {waiting ? "Get a new link" : "Connect Telegram"}
            </button>
          </div>
          {waiting ? (
            <p className="text-sm text-ink-2" role="status">
              In Telegram, press <strong>Start</strong> in the chat that opened. This page updates when it&rsquo;s linked.{" "}
              <a href={link.url} target="_blank" rel="noopener" className="text-accent underline">
                Open the link again
              </a>
            </p>
          ) : (
            <p className="text-xs text-ink-2">Opens our bot in Telegram; press Start to get alerts in that chat. Send /stop there to turn them off.</p>
          )}
        </div>
      )}
      <Note message={message} />
    </Row>
  );
}
