"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/Badge";
import { ThumbsDownIcon, ThumbsUpIcon } from "@/components/icons";
import { Logo } from "@/components/Logo";
import { inputClass, primaryButton } from "@/components/ui";
import { NOTE_MAX_LENGTH } from "@/lib/feedback";
import { actionInfo, parseReasoning, timeAgo } from "@/lib/format";
import type { Feedback, RatingLink } from "@/lib/types";

// The page behind "Right call" / "Wrong call" in Slack and email alerts: no
// sign-in, the link's signed token names the one decision it can rate.
// Nothing is saved until Save, because mail scanners open links by themselves.

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const LABELS: Record<Feedback, string> = { up: "right call", down: "wrong call" };

async function rateRequest<T>(token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/rate/${encodeURIComponent(token)}`, { ...init, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

function RateForm() {
  const params = useSearchParams();
  const token = params.get("t") ?? "";
  const r = params.get("r");
  const picked: Feedback | null = r === "up" || r === "down" ? r : null;
  const [link, setLink] = useState<RatingLink | null>(null);
  const [loadError, setLoadError] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(picked);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState<Feedback | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    rateRequest<RatingLink>(token)
      .then((body) => {
        if (cancelled) return;
        setLink(body);
        setNote(body.decision.feedback_note ?? "");
        // The button that was clicked wins; otherwise show the rating it has.
        setFeedback((current) => current ?? body.decision.feedback);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!feedback) return;
    setBusy(true);
    setSaveError("");
    try {
      const result = await rateRequest<{ feedback: Feedback }>(token, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback, note: note.trim() || null }),
      });
      setSaved(result.feedback);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const error = token ? loadError : "This rating link isn't valid.";
  const header = (
    <div className="flex items-center gap-3">
      <Logo />
      <h1 className="text-lg font-semibold tracking-tight">Rate the agent&rsquo;s call</h1>
    </div>
  );
  const card = "glow relative grid w-full max-w-md gap-4 rounded-xl border border-border bg-surface p-7";

  if (error || !link) {
    return (
      <div className={card}>
        {header}
        {error ? (
          <>
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
            <Link href="/decisions" className="text-sm font-medium text-accent underline">
              Open the Decisions page
            </Link>
          </>
        ) : (
          <p className="text-sm text-ink-2">Loading the decision…</p>
        )}
      </div>
    );
  }

  const { decision } = link;
  const action = actionInfo(decision.action_taken);
  const headline = parseReasoning(decision.headline).headline;

  if (saved) {
    return (
      <div className={card} role="status">
        {header}
        <p className="text-sm">
          Saved: <span className="font-semibold">{LABELS[saved]}</span>. Thanks. The agent reads your ratings and notes before it decides on
          similar events.
        </p>
        <Link href="/decisions" className="text-sm font-medium text-accent underline">
          Open the dashboard
        </Link>
      </div>
    );
  }

  const choice = (value: Feedback, Glyph: typeof ThumbsUpIcon, text: string) => {
    const pressed = feedback === value;
    const tone = value === "up" ? "border-good/30 bg-good/10 text-good" : "border-critical/30 bg-critical/10 text-critical";
    return (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={() => setFeedback(value)}
        className={`inline-flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${focusRing} ${
          pressed ? tone : "border-border text-ink-2 hover:border-ink-2/40 hover:text-ink"
        }`}
      >
        <Glyph aria-hidden="true" weight={pressed ? "fill" : "regular"} className="size-5" />
        {text}
      </button>
    );
  };

  return (
    <form onSubmit={save} className={card}>
      {header}
      {link.business_name && <p className="-mt-2 text-sm text-ink-2">For {link.business_name}</p>}

      <div className="grid gap-1.5 rounded-lg border border-hairline bg-page/60 px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge label={action.label} tone={action.tone} icon={action.icon} />
          <span className="font-semibold">{decision.order_number ? `Order ${decision.order_number}` : "Low-stock alert"}</span>
          <span className="ml-auto text-sm text-ink-2">{timeAgo(decision.created_at)}</span>
        </div>
        {headline && <p className="text-sm">{headline}</p>}
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Was this the right call?</legend>
        <div className="flex gap-2">
          {choice("up", ThumbsUpIcon, "Right call")}
          {choice("down", ThumbsDownIcon, "Wrong call")}
        </div>
      </fieldset>

      {feedback && (
        <label className="grid gap-1.5 text-sm">
          <span className="text-ink-2">{feedback === "down" ? "What should it have done? (optional)" : "Anything to add? (optional)"}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX_LENGTH} rows={3} className={`${inputClass} resize-y`} />
          <span className="text-xs text-ink-2">The agent reads your wrong calls and notes before it decides on similar events.</span>
        </label>
      )}

      {saveError && (
        <p role="alert" className="text-sm text-error">
          {saveError}
        </p>
      )}
      <button type="submit" disabled={busy || !feedback} className={primaryButton}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export default function RatePage() {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense>
        <RateForm />
      </Suspense>
    </main>
  );
}
