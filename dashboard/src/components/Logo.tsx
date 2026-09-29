// The mark, "the Caret": a 60-degree chevron (the A of AI Ops, a command
// caret) with a lime crossbar that floats free of the legs: the agent's call,
// waiting for the seller to close it. Paper chevron and lime bar on dark;
// `onLime` draws both in ink, for a lime tile. The same shapes are in
// app/icon.svg.
export function Logo({ className = "size-8", onLime = false }: { className?: string; onLime?: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 64" className={`shrink-0 ${className}`}>
      <path
        d="M10.5 51 L32 13.8 L53.5 51"
        fill="none"
        stroke={onLime ? "var(--on-accent)" : "var(--ink)"}
        strokeWidth="9.5"
        strokeLinejoin="miter"
        strokeMiterlimit="4"
      />
      <path d="M25.52 39.5H38.48L42.82 47H21.18Z" fill={onLime ? "var(--on-accent)" : "var(--accent)"} />
    </svg>
  );
}

// The wordmark next to the mark: "AI Ops" in the display face, the full name
// under it in spaced capitals.
export function Lockup({ small = false }: { small?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo className={small ? "size-7" : "size-9"} />
      <span className="leading-none">
        <span className={`block font-display font-semibold tracking-[-0.03em] ${small ? "text-[19px]" : "text-[24px]"}`}>AI Ops</span>
        <span className={`mt-1 block font-mono text-[11px] font-semibold uppercase text-ink-2 ${small ? "tracking-[0.12em]" : "tracking-[0.26em]"}`}>Command Center</span>
      </span>
    </span>
  );
}
