"use client";

import { useState } from "react";
import { Panel } from "@/components/Panel";
import { Note, primaryButton, secondaryButton, Subhead, type Message } from "@/components/ui";
import { browserTimeZone, hourLabel, LATE_AFTER_HOURS, timeZoneOptions } from "@/lib/reports";
import type { AlertResult, ReportSettings, Settings } from "@/lib/types";
import { jsonBody, useApi } from "@/lib/useApi";

const CHANNEL_NAMES: Record<AlertResult["channel"], string> = { slack: "Slack", email: "Email", telegram: "Telegram" };
const selectClass =
  "rounded-lg border border-border bg-page px-2.5 py-1.5 text-sm text-ink transition-colors hover:border-ink-2/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60";
const HOURS = Array.from({ length: 24 }, (_, h) => h);

// The daily summary and late-order alerts. Both go to the alert channels
// above, and both are off until turned on here.
export function ReportsSection({ settings, onChange }: { settings: Settings; onChange: () => Promise<void> }) {
  const call = useApi();
  const saved = settings.reports;
  const [timezone, setTimezone] = useState(saved.timezone ?? browserTimeZone());
  const [summaryOn, setSummaryOn] = useState(saved.summary.enabled);
  const [hour, setHour] = useState(saved.summary.hour);
  const [lateOn, setLateOn] = useState(saved.late_orders.enabled);
  const [afterHours, setAfterHours] = useState(saved.late_orders.after_hours);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [sendMessage, setSendMessage] = useState<Message>(null);
  const anyChannel = settings.slack.connected || Boolean(settings.email_alerts.address) || settings.telegram.connected;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const { reports } = await call<{ reports: ReportSettings }>("/api/settings/reports", {
        method: "PUT",
        ...jsonBody({ timezone, summary: { enabled: summaryOn, hour }, late_orders: { enabled: lateOn, after_hours: afterHours } }),
      });
      const summary = reports.summary.enabled ? `The summary comes every day at ${hourLabel(reports.summary.hour)} (${reports.timezone}).` : "";
      setMessage({ text: `Saved. ${summary}`.trim(), isError: false });
      await onChange();
    } catch (err) {
      setMessage({ text: (err as Error).message, isError: true });
    } finally {
      setBusy(false);
    }
  }

  async function sendNow() {
    setSending(true);
    setSendMessage(null);
    try {
      const { results } = await call<{ results: AlertResult[] }>("/api/settings/reports/summary", { method: "POST" });
      const text = results.map((r) => `${CHANNEL_NAMES[r.channel]}: ${r.ok ? "sent" : `failed (${r.error})`}`).join(" · ");
      setSendMessage({ text, isError: results.some((r) => !r.ok) });
    } catch (err) {
      setSendMessage({ text: (err as Error).message, isError: true });
    } finally {
      setSending(false);
    }
  }

  return (
    <Panel title="Daily summary and late orders">
      <form onSubmit={save} className="grid max-w-2xl gap-4">
        <p className="text-sm text-ink-2">
          Both go to the alert channels above.
          {!anyChannel && <span className="text-ink"> Turn on a channel first, or they only reach the server log.</span>}
        </p>

        <div className="grid gap-2">
          <Subhead>Daily summary</Subhead>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={summaryOn} onChange={(e) => setSummaryOn(e.target.checked)} className="size-4 accent-accent" />
            Send me a summary of the day before, every day at
            <select
              aria-label="Hour"
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
              disabled={!summaryOn}
              className={`${selectClass} tabular-nums`}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-ink-2">
            Orders and sales against the day before, what needs action, late orders, stock running out, and the agent&rsquo;s decisions with how
            you rated them.
          </p>
        </div>

        <div className="grid gap-2">
          <Subhead>Late orders</Subhead>
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <input type="checkbox" checked={lateOn} onChange={(e) => setLateOn(e.target.checked)} className="size-4 accent-accent" />
            Tell me when a paid order still isn&rsquo;t shipped after
            <select
              aria-label="Hours"
              value={afterHours}
              onChange={(e) => setAfterHours(Number(e.target.value))}
              disabled={!lateOn}
              className={`${selectClass} tabular-nums`}
            >
              {LATE_AFTER_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h} hours
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-ink-2">Once per order. Orders waiting for payment don&rsquo;t count.</p>
        </div>

        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Your time zone</span>
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={`${selectClass} max-w-sm`}>
            {timeZoneOptions(timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-2">For the summary&rsquo;s hour and what counts as &ldquo;the day before&rdquo;.</span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={sendNow} disabled={sending || !anyChannel} className={secondaryButton}>
            {sending ? "Sending…" : "Send a summary now"}
          </button>
        </div>
        <Note message={message} />
        <Note message={sendMessage} />
      </form>
    </Panel>
  );
}
