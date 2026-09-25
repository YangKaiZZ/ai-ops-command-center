// Helpers for the seller's ratings of agent decisions: thumbs up means the
// agent made the right call, thumbs down the wrong one.
import type { Action, Decision, RatingCounts } from "./types";

export const NOTE_MAX_LENGTH = 500; // the backend's limit

// A skipped run never reached the agent, so there's no call to rate.
export function canRate(action: Action): boolean {
  return action !== "skipped";
}

// The share rated right as a whole percent. It only says 100% when none were
// wrong, and 0% when none were right.
export function accuracyPercent({ up, down }: Pick<RatingCounts, "up" | "down">): number | null {
  const rated = up + down;
  if (rated === 0) return null;
  const percent = Math.round((up / rated) * 100);
  if (percent === 100 && down > 0) return 99;
  if (percent === 0 && up > 0) return 1;
  return percent;
}

// e.g. "12 of 14 rated right (86%)", or null before anything is rated.
export function accuracyText(counts: Pick<RatingCounts, "up" | "down">): string | null {
  const percent = accuracyPercent(counts);
  return percent === null ? null : `${counts.up} of ${counts.up + counts.down} rated right (${percent}%)`;
}

export type DecisionFilter = "all" | "unrated" | "wrong";
export const DECISION_FILTERS: DecisionFilter[] = ["all", "unrated", "wrong"];

// The decisions a filter on the Decisions page shows. `keep` are decisions
// rated since the filter was picked: they stay in view, so a card doesn't
// vanish from under the seller the moment they rate it.
export function filterDecisions<T extends Pick<Decision, "id" | "action_taken" | "feedback">>(
  decisions: T[],
  filter: DecisionFilter,
  keep: ReadonlySet<number> = new Set()
): T[] {
  if (filter === "all") return decisions;
  const shown = filter === "unrated" ? (d: T) => d.feedback === null && canRate(d.action_taken) : (d: T) => d.feedback === "down";
  return decisions.filter((d) => shown(d) || keep.has(d.id));
}
