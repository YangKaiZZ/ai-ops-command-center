import { CheckIcon, CircleDashedIcon, PauseIcon, ProhibitIcon, QuestionIcon, WarningIcon, type Icon } from "@/components/icons";
import type { IconName, Tone } from "@/lib/format";

// A translucent pill in the tone's own color: a faint fill, a crisp edge.
// Tailwind only sees class names written out in full, so each tone is spelled out.
const TONE_CLASSES: Record<Tone, string> = {
  good: "border-good/25 bg-good/10 text-good",
  warning: "border-warning/25 bg-warning/10 text-warning",
  serious: "border-serious/25 bg-serious/10 text-serious",
  critical: "border-critical/25 bg-critical/10 text-critical",
  neutral: "border-neutral/25 bg-neutral/10 text-neutral",
};

const ICONS: Record<IconName, Icon> = {
  check: CheckIcon,
  pause: PauseIcon,
  alert: WarningIcon,
  empty: ProhibitIcon,
  help: QuestionIcon,
  todo: CircleDashedIcon,
};

// A status is always icon + text label; the color is never the only signal.
export function Badge({ label, tone, icon }: { label: string; tone: Tone; icon: IconName }) {
  const Glyph = ICONS[icon];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pl-1.5 pr-2.5 text-xs font-semibold tabular-nums ${TONE_CLASSES[tone]}`}
      data-tone={tone}
    >
      <Glyph aria-hidden="true" weight="bold" className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}
