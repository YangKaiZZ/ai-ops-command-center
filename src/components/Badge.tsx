import type { IconName, Tone } from "@/lib/format";

// Tailwind only sees class names written out in full, so each tone is spelled out.
const TONE_CLASSES: Record<Tone, { chip: string; icon: string }> = {
  good: { chip: "bg-good/15", icon: "text-good" },
  warning: { chip: "bg-warning/20", icon: "text-warning" },
  serious: { chip: "bg-serious/20", icon: "text-serious" },
  critical: { chip: "bg-critical/15", icon: "text-critical" },
  neutral: { chip: "bg-neutral/15", icon: "text-neutral" },
};

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  check: <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  pause: (
    <>
      <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.2L1.8 13h12.4z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8 6.5v3M8 11.3v.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
  empty: (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M4 12L12 4" stroke="currentColor" strokeWidth="2" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.2 6.2a1.9 1.9 0 113 1.5c-.7.4-1.2.8-1.2 1.6M8 11.5v.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </>
  ),
};

// A status is always icon + text label; the color is never the only signal.
export function Badge({ label, tone, icon }: { label: string; tone: Tone; icon: IconName }) {
  const classes = TONE_CLASSES[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-1.5 pr-2.5 text-xs font-semibold text-ink ${classes.chip}`}
      data-tone={tone}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" className={`size-3.5 shrink-0 ${classes.icon}`}>
        {ICON_PATHS[icon]}
      </svg>
      {label}
    </span>
  );
}
