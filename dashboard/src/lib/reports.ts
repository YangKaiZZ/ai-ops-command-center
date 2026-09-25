// Helpers for the daily summary and late-order settings.

export const LATE_AFTER_HOURS = [12, 24, 48, 72]; // what the backend accepts

// 8 -> "08:00"
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

// The browser's own time zone, the default until the seller saves one.
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Time zones to choose from: every one the browser knows, plus UTC and the
// current choice (so a saved zone always shows), sorted.
export function timeZoneOptions(current: string, known: string[] = supportedTimeZones()): string[] {
  return [...new Set([...known, "UTC", current])].sort((a, b) => a.localeCompare(b));
}

function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    return [];
  }
}
