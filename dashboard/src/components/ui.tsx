// Shared form styling and the one-line status/error message under a form.

// Inputs are a darker well inside the card, lit lime at the edge when focused.
export const inputClass =
  "min-w-0 flex-1 rounded-lg border border-border bg-page px-3 py-2 text-sm text-ink placeholder:text-ink-2/60 transition-colors hover:border-ink-2/40 focus-visible:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
// An input inside its (medium-weight) label, on the sign-in and sign-up cards.
export const labelledInputClass =
  "rounded-lg border border-border bg-page px-3 py-2 font-normal text-ink placeholder:text-ink-2/60 transition-colors hover:border-ink-2/40 focus-visible:border-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
// Solid lime is kept for main actions: Sync, and each form's submit button. `accentButton` leaves
// the disabled cursor to the caller; `primaryButton` shows it as busy.
export const accentButton =
  "rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-on-accent shadow-[0_0_20px_-6px_rgb(182_255_46/0.5)] transition hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 disabled:shadow-none disabled:hover:brightness-100";
export const primaryButton = `${accentButton} disabled:cursor-progress`;
export const secondaryButton =
  "rounded-lg border border-border bg-surface px-3.5 py-2 text-sm font-medium transition-colors hover:border-ink-2/40 hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-progress disabled:opacity-60";
export const dangerTextButton =
  "rounded-lg px-2.5 py-1 text-sm font-medium text-error hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60";

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
