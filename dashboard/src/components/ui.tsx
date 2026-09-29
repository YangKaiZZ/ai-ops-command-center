// Shared form styling, page headers, tabs, and the one-line status/error
// message under a form.
import Link from "next/link";

export const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// Inputs are a darker well inside the card, lit lime at the edge when focused.
export const inputClass =
  "min-w-0 flex-1 rounded-lg border border-border bg-field px-3 py-2 text-sm text-ink placeholder:text-ink-2/70 transition-colors hover:border-ink-2/40 focus-visible:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
// An input inside its (medium-weight) label, on the sign-in and sign-up cards.
export const labelledInputClass =
  "rounded-lg border border-border bg-field px-3 py-2 font-normal text-ink placeholder:text-ink-2/70 transition-colors hover:border-ink-2/40 focus-visible:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
// A compact select or input for filter bars.
export const fieldClass = `rounded-lg border border-border bg-field px-2.5 py-1.5 text-[13px] text-ink transition-colors hover:border-ink-2/40 ${focusRing}`;
// Solid lime is kept for main actions: Sync, and each form's submit button. `accentButton` leaves
// the disabled cursor to the caller; `primaryButton` shows it as busy.
export const accentButton = `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-accent bg-accent px-3.5 py-2 text-[13px] font-semibold text-on-accent transition hover:brightness-105 hover:shadow-[0_0_0_3px_rgb(182_255_46/0.14)] ${focusRing} disabled:opacity-60 disabled:hover:brightness-100 disabled:hover:shadow-none`;
export const primaryButton = `${accentButton} disabled:cursor-progress`;
// The agent's call where it repeats down a list (one per row): lime, but only
// its edge and text, so a list of them doesn't shout.
export const accentOutlineButton = `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-accent/35 bg-accent/[0.06] px-3.5 py-2 text-[13px] font-semibold text-accent transition-colors hover:border-accent/60 hover:bg-accent/10 ${focusRing}`;
export const secondaryButton = `inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-border bg-field px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:border-ink-2/40 hover:bg-hairline ${focusRing} disabled:cursor-progress disabled:opacity-60`;
// Appended to a button class: a size down, for rows in a list.
export const small = "!px-2.5 !py-1.5 !text-xs";
export const dangerTextButton = `rounded-lg px-2.5 py-1 text-sm font-medium text-error hover:bg-ink/5 ${focusRing} disabled:opacity-60`;

// A small label in spaced mono capitals, like an instrument panel's (table headings too).
export const eyebrow = "font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-ink-2";

export type Message = { text: string; isError: boolean } | null;

export function Note({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p role={message.isError ? "alert" : "status"} className={`text-sm ${message.isError ? "text-error" : "text-ink-2"}`}>
      {message.text}
    </p>
  );
}

// A sub-heading inside a settings panel.
export function Subhead({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

// Each page's title, a line under it, and its own buttons on the right.
export function PageHeader({ title, sub, children }: { title: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
        {sub && <div className="mt-1 text-[13.5px] text-ink-2">{sub}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2.5">{children}</div>}
    </div>
  );
}

export type TabItem<K extends string> = { key: K; label: string; count?: number | null; href?: string };

// Underlined tabs with counts. Given hrefs they're links (the view is in the
// URL); otherwise buttons that call `onSelect`.
export function Tabs<K extends string>({
  label,
  tabs,
  active,
  onSelect,
}: {
  label: string;
  tabs: TabItem<K>[];
  active: K | null;
  onSelect?: (key: K) => void;
}) {
  const tabClass = (on: boolean) =>
    `-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-[13.5px] font-medium transition-colors ${focusRing} ${
      on ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"
    }`;
  const count = (tab: TabItem<K>) => tab.count != null && <span className="font-mono text-xs tabular-nums text-ink-2">{tab.count}</span>;
  return (
    <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]">
      {tabs.map((tab) =>
        tab.href ? (
          <Link
            key={tab.key}
            href={tab.href}
            scroll={false}
            aria-current={tab.key === active ? "page" : undefined}
            className={tabClass(tab.key === active)}
          >
            {tab.label} {count(tab)}
          </Link>
        ) : (
          <button key={tab.key} type="button" aria-pressed={tab.key === active} onClick={() => onSelect?.(tab.key)} className={tabClass(tab.key === active)}>
            {tab.label} {count(tab)}
          </button>
        )
      )}
    </nav>
  );
}
