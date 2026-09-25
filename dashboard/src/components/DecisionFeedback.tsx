"use client";

import { useId, useRef, useState } from "react";
import { NOTE_MAX_LENGTH } from "@/lib/feedback";
import type { Decision, Feedback, SavedFeedback } from "@/lib/types";
import { jsonBody, useApi } from "@/lib/useApi";
import { ThumbsDownIcon, ThumbsUpIcon } from "@/components/icons";
import { inputClass, primaryButton, secondaryButton } from "@/components/ui";

type Rated = Pick<Decision, "id" | "feedback" | "feedback_note">;
type Saved = { feedback: Feedback | null; note: string | null };

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const linkButton = `rounded text-sm font-medium text-accent hover:underline ${focusRing}`;

// Outlined until pressed, then filled in the rating's color.
function Thumb({ down = false, pressed }: { down?: boolean; pressed: boolean }) {
  const Glyph = down ? ThumbsDownIcon : ThumbsUpIcon;
  const tone = down ? "text-critical" : "text-good";
  return <Glyph aria-hidden="true" weight={pressed ? "fill" : "regular"} className={`size-4 shrink-0 ${pressed ? tone : ""}`} />;
}

// "Right call?" with thumbs up and down under a decision, and an optional
// note. Saves as soon as a thumb is clicked; clicking the pressed one again
// clears the rating. A thumbs down opens the note box, since that's when a
// few words about what it should have done help most.
export function DecisionFeedback({ decision, onSaved }: { decision: Rated; onSaved?: (saved: SavedFeedback) => void }) {
  const api = useApi();
  const labelId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const fromProps: Saved = { feedback: decision.feedback, note: decision.feedback_note };
  const [saved, setSaved] = useState<Saved>(fromProps);
  // When the dashboard reloads with a different rating (e.g. from another tab), show that.
  const [seen, setSeen] = useState<Saved>(fromProps);
  if (seen.feedback !== fromProps.feedback || seen.note !== fromProps.note) {
    setSeen(fromProps);
    setSaved(fromProps);
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Shown straight away, put back if the save fails.
  async function save(next: Saved): Promise<boolean> {
    const before = saved;
    setSaved(next);
    setBusy(true);
    setError("");
    try {
      const result = await api<SavedFeedback>(`/api/decisions/${decision.id}/feedback`, {
        method: "PUT",
        ...jsonBody({ feedback: next.feedback, note: next.note }),
      });
      setSaved({ feedback: result.feedback, note: result.feedback_note });
      onSaved?.(result);
      return true;
    } catch (err) {
      setSaved(before);
      setError(`Couldn't save that: ${(err as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openNote(text: string) {
    setDraft(text);
    setEditing(true);
    // After the box renders.
    requestAnimationFrame(() => noteRef.current?.focus());
  }

  async function rate(value: Feedback) {
    const clearing = saved.feedback === value;
    const ok = await save(clearing ? { feedback: null, note: null } : { feedback: value, note: saved.note });
    if (clearing) setEditing(false);
    else if (ok && value === "down" && !saved.note) openNote("");
  }

  async function saveNote(event: React.FormEvent) {
    event.preventDefault();
    if (!saved.feedback) return;
    if (await save({ feedback: saved.feedback, note: draft.trim() || null })) setEditing(false);
  }

  const thumbClass = (value: Feedback) => {
    const pressed = saved.feedback === value;
    const tone = value === "up" ? "border-good/30 bg-good/10" : "border-critical/30 bg-critical/10";
    return `inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors disabled:cursor-progress ${focusRing} ${
      pressed ? `${tone} text-ink` : "border-border text-ink-2 hover:border-ink-2/40 hover:text-ink"
    }`;
  };

  return (
    <div className="grid gap-2 border-t border-hairline pt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="text-sm text-ink-2">
          Right call?
        </span>
        <div role="group" aria-labelledby={labelId} className="flex gap-1.5">
          <button type="button" aria-pressed={saved.feedback === "up"} disabled={busy} onClick={() => rate("up")} className={thumbClass("up")}>
            <Thumb pressed={saved.feedback === "up"} />
            Yes
          </button>
          <button type="button" aria-pressed={saved.feedback === "down"} disabled={busy} onClick={() => rate("down")} className={thumbClass("down")}>
            <Thumb down pressed={saved.feedback === "down"} />
            No
          </button>
        </div>
        {saved.feedback && !saved.note && !editing && (
          <button type="button" className={linkButton} onClick={() => openNote("")}>
            Add a note
          </button>
        )}
      </div>

      {saved.note && !editing && (
        <p className="text-sm">
          <span className="text-ink-2">Your note: </span>
          <span className="whitespace-pre-line">{saved.note}</span>{" "}
          <button type="button" className={linkButton} onClick={() => openNote(saved.note ?? "")}>
            Edit
          </button>
        </p>
      )}

      {editing && (
        <form onSubmit={saveNote} className="grid gap-2">
          <label className="grid gap-1 text-sm">
            <span className="text-ink-2">
              {saved.feedback === "down" ? "What should it have done? (optional)" : "Anything to add? (optional)"}
            </span>
            <textarea
              ref={noteRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={NOTE_MAX_LENGTH}
              rows={2}
              className={`${inputClass} resize-y`}
            />
          </label>
          <div className="flex items-center gap-2">
            <button type="submit" disabled={busy} className={primaryButton}>
              Save note
            </button>
            <button type="button" className={secondaryButton} onClick={() => setEditing(false)}>
              Cancel
            </button>
            {draft.length > NOTE_MAX_LENGTH - 50 && (
              <span className="ml-auto text-xs tabular-nums text-ink-2">
                {draft.length}/{NOTE_MAX_LENGTH}
              </span>
            )}
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
