// The dashboard's tokens (dashboard/src/app/globals.css), so the ad looks
// like the product: Ink, Paper, and Signal Lime for what matters most.
export const color = {
  page: "#0b0d0a",
  sidebar: "#080907",
  line: "#1d201a",
  surface: "#121410",
  field: "#181b15",
  well: "#0e100c",
  ink: "#eceee6",
  inkSoft: "#c9cdc1",
  ink2: "#8a9084",
  hairline: "#1f231c",
  border: "#282c24",
  accent: "#b6ff2e",
  onAccent: "#0b0d0a",
  good: "#b6ff2e",
  warning: "#f5b342",
  serious: "#ff9a5c",
  critical: "#ff8a7a",
  neutral: "#a0a697",
} as const;

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

export const font = {
  display: "Archivo, Inter, system-ui, sans-serif",
  sans: "Inter, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

// Archivo set wide, as the dashboard's titles are.
export const displayStyle = {
  fontFamily: font.display,
  fontVariationSettings: '"wdth" 112',
  fontWeight: 700,
  letterSpacing: "-0.02em",
} as const;

export const FPS = 30;
