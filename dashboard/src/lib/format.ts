import type { Action } from "./types";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";
export type IconName = "check" | "pause" | "alert" | "empty" | "help";

export const ACTIONS: Record<Action, { label: string; tone: Tone; icon: IconName }> = {
  fulfill: { label: "Fulfill", tone: "good", icon: "check" },
  hold: { label: "Hold", tone: "warning", icon: "pause" },
  low_stock_alert: { label: "Restock", tone: "serious", icon: "alert" },
  unknown: { label: "Unclear", tone: "neutral", icon: "help" },
};

export function actionInfo(action: string) {
  return ACTIONS[action as Action] ?? ACTIONS.unknown;
}

// Low-stock bar color. Red means nothing left to sell; amber means some left
// but at or under the threshold. Kept as one tested function because the
// original dashboard's CSS got this wrong.
export function stockTone(quantity: number, threshold: number): "critical" | "warning" | "good" {
  if (quantity <= 0) return "critical";
  if (quantity <= threshold) return "warning";
  return "good";
}

// How full the bar is: stock as a share of the threshold, clamped to 0-100.
export function stockPercent(quantity: number, threshold: number): number {
  return Math.min(100, Math.max(0, (quantity / Math.max(threshold, 1)) * 100));
}

// The agent's reply is "VERDICT - headline" on line 1, then bullets.
// The verdict word is dropped (the badge shows it); bullets and plain lines are kept apart.
export function parseReasoning(reasoning: string) {
  const lines = (reasoning ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = (lines.shift() ?? "").replace(/^\**(FULFILL|HOLD|RESTOCK)\**\s*[-–—:]*\s*/, "");
  const blocks: ({ type: "bullets"; items: string[] } | { type: "text"; text: string })[] = [];
  for (const line of lines) {
    const bullet = line.match(/^[-*•]\s*(.*)$/);
    const last = blocks[blocks.length - 1];
    if (bullet) {
      if (last?.type === "bullets") last.items.push(bullet[1]);
      else blocks.push({ type: "bullets", items: [bullet[1]] });
    } else {
      blocks.push({ type: "text", text: line });
    }
  }
  return { headline, blocks };
}

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const money = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatMoney(amount: string | null): string {
  return amount == null ? "—" : money.format(Number(amount));
}

// The ?shop= that Shopify's install link brings to sign-up, if it's a real
// store address (same rule as the backend); "" otherwise.
export function shopParam(value: string | null): string {
  const shop = (value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : "";
}
