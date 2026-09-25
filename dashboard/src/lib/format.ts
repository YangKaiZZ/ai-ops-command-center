import type { Action, ForecastHistory, ItemForecast } from "./types";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";
export type IconName = "check" | "pause" | "alert" | "empty" | "help" | "todo";

export const ACTIONS: Record<Action, { label: string; tone: Tone; icon: IconName }> = {
  fulfill: { label: "Fulfill", tone: "good", icon: "check" },
  hold: { label: "Hold", tone: "warning", icon: "pause" },
  low_stock_alert: { label: "Restock", tone: "serious", icon: "alert" },
  unknown: { label: "Unclear", tone: "neutral", icon: "help" },
  skipped: { label: "Skipped", tone: "neutral", icon: "empty" },
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Units a day, rounded the way a person would say it: "about 1.3", "about 12".
export function formatPace(perDay: number): string {
  if (perDay <= 0) return "0";
  if (perDay < 0.1) return "under 0.1";
  return `about ${perDay < 10 ? Math.round(perDay * 10) / 10 : Math.round(perDay)}`;
}

// A day without the year, in the seller's language, e.g. "Sep 28".
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDaysLeft(days: number): string {
  return days < 1 ? "under a day" : `about ${plural(Math.round(days), "day")}`;
}

// The forecast line under a stock item, e.g. ["Sells about 1.3 a day",
// "runs out in about 8 days (Oct 3)"]. The reorder amount is shown apart.
export function forecastPhrases(
  f: Pick<ItemForecast, "units_sold" | "per_day" | "days_left" | "runs_out_at">,
  lookbackDays: number,
  formatDate: (iso: string) => string
): string[] {
  if (f.units_sold === 0) return [`No sales in the last ${plural(lookbackDays, "day")}`];
  const phrases = [`Sells ${formatPace(f.per_day)} a day`];
  if (f.days_left != null && f.days_left > 0) {
    phrases.push(`runs out in ${formatDaysLeft(f.days_left)}${f.runs_out_at ? ` (${formatDate(f.runs_out_at)})` : ""}`);
  }
  return phrases;
}

// Why a forecast is rough (confidence "low": under 3 orders or under a week
// of history), or null when it isn't. An item that isn't selling has no forecast to doubt.
export function roughNote(f: Pick<ItemForecast, "confidence" | "units_sold" | "orders">): string | null {
  if (f.confidence !== "low" || f.units_sold === 0) return null;
  return f.orders < 3 ? `rough estimate: ${plural(f.orders, "order")}` : "rough estimate: under a week of orders";
}

// What every forecast on the page is based on, in a sentence or three.
export function historySummary(history: ForecastHistory, formatDate: (iso: string) => string): string {
  if (!history.from) return "No orders yet, so there's nothing to forecast from.";
  const days = history.days < 1 ? "less than a day" : plural(Math.round(history.days), "day");
  let text = `Forecasts are based on ${days} of orders: ${plural(history.orders, "order")} since ${formatDate(history.from)}.`;
  if (history.days < 7) text += " They're rough until there's at least a week of orders.";
  const missing = history.orders_missing_items;
  if (missing) {
    text += ` ${plural(missing, "order")} from then ${missing === 1 ? "doesn't" : "don't"} have ${missing === 1 ? "its" : "their"} items yet, so ${missing === 1 ? "its" : "their"} sales aren't counted.`;
  }
  return text;
}

// The agent's reply is "VERDICT - headline" on line 1, then bullets.
// The verdict word is dropped (the badge shows it); bullets and plain lines are kept apart.
export function parseReasoning(reasoning: string) {
  const lines = (reasoning ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = (lines.shift() ?? "").replace(/^\**(FULFILL|HOLD|RESTOCK|SKIPPED)\**\s*[-–—:]*\s*/, "");
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
