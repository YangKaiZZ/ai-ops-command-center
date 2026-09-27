// Helpers for the Overview page: the period it covers, changes against the
// period before, and numbers short enough for a tile.

export const PERIOD_DAYS = 7;
// The lengths the Overview offers (?days=); the API allows up to 31 days back.
export const PERIOD_CHOICES = [7, 14, 30] as const;

// The ?days= value as one of the choices, or the default.
export function readPeriod(value: string | null): number {
  const days = Number(value);
  return (PERIOD_CHOICES as readonly number[]).includes(days) ? days : PERIOD_DAYS;
}

// The change as a share of the period before, e.g. "+20%", or null when
// there's nothing before to compare with (or no change).
export function percentChange(current: number, previous: number): string | null {
  if (!previous || current === previous) return null;
  const percent = Math.round(((current - previous) / previous) * 100);
  if (percent === 0) return null;
  return `${percent > 0 ? "+" : "−"}${Math.abs(percent)}%`;
}

// A date as YYYY-MM-DD in the seller's own time zone (what the Orders page's
// date filter takes).
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// "Last 7 days" includes today: it starts at local midnight 6 days ago.
export function periodStart(now: Date, days = PERIOD_DAYS): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
}

export type Change = { direction: "up" | "down" | "same"; text: string };

// This period against the one before, e.g. "+3" or "−120.50" ("same" when equal).
export function change(current: number, previous: number, format: (n: number) => string = String): Change {
  const diff = Math.round((current - previous) * 100) / 100;
  if (diff === 0) return { direction: "same", text: "no change" };
  return { direction: diff > 0 ? "up" : "down", text: `${diff > 0 ? "+" : "−"}${format(Math.abs(diff))}` };
}

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const cents = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// A count for a tile: 1,284, then 12.9K from ten thousand up.
export function tileCount(n: number): string {
  return Math.abs(n) < 10_000 ? whole.format(n) : compact.format(n);
}

// An amount for a tile: 1,234.50, then 12.9K from ten thousand up.
export function tileMoney(amount: number): string {
  return Math.abs(amount) < 10_000 ? cents.format(amount) : compact.format(amount);
}

// The line under the "Flagged for fraud" tile: the period before, said
// without an up/down color (fewer is better here, unlike orders and sales).
export function fraudComparison(previous: number, days = PERIOD_DAYS): string {
  return previous ? `${tileCount(previous)} in the ${days} days before` : `None in the ${days} days before`;
}
