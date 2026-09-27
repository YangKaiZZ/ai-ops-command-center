// Helpers for the Stock page: counts for its stat cards and the reorder list as CSV.
import type { InventoryItem, ItemForecast } from "./types";

export const SOON_DAYS = 7; // "runs out soon" means within this many days, as on the Overview

// Units a day as a short number for a table: "0", "<0.1", "1.3", "12".
export function perDayText(perDay: number): string {
  if (perDay <= 0) return "0";
  if (perDay < 0.1) return "<0.1";
  return String(perDay < 10 ? Math.round(perDay * 10) / 10 : Math.round(perDay));
}

// The numbers on the Stock page's cards.
export function stockCounts(inventory: InventoryItem[], forecasts: ItemForecast[] | null) {
  return {
    tracked: inventory.length,
    outOfStock: inventory.filter((item) => item.stock_quantity <= 0).length,
    runningOut: forecasts ? forecasts.filter((f) => f.days_left != null && f.days_left > 0 && f.days_left <= SOON_DAYS).length : null,
    toReorder: forecasts ? forecasts.filter((f) => f.reorder_quantity > 0).length : null,
  };
}

// A CSV cell: quoted when it holds a comma, quote or line break. A leading
// =, +, - or @ gets an apostrophe so a spreadsheet doesn't run it as a formula.
function cell(value: string | number | null): string {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// The items to reorder, soonest to run out first, as a CSV a supplier order
// can start from. `formatDay` writes the run-out date as the seller sees it.
export function reorderCsv(forecasts: ItemForecast[], coverDays: number, formatDay: (iso: string) => string): string {
  const rows: (string | number | null)[][] = [
    ["Item", "In stock", "Sells per day", "Days left", "Runs out", `Reorder (to last ${coverDays} days)`],
  ];
  for (const f of forecasts) {
    if (f.reorder_quantity <= 0) continue;
    rows.push([
      f.item_name,
      f.stock_quantity,
      perDayText(f.per_day),
      f.days_left == null ? null : Math.round(f.days_left),
      f.runs_out_at ? formatDay(f.runs_out_at) : null,
      f.reorder_quantity,
    ]);
  }
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
