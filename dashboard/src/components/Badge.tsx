import {
  CheckIcon,
  CircleDashedIcon,
  PauseIcon,
  ProhibitIcon,
  QuestionIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  WarningIcon,
  type Icon,
} from "@/components/icons";
import type { IconName, Tone } from "@/lib/format";

// A chip in the tone's own color: a thin edge and a faint fill of it, led by
// a square pip (the brand's crossbar) or an icon.
// Tailwind only sees class names written out in full, so each tone is spelled out.
const TONE_CLASSES: Record<Tone, string> = {
  good: "border-good/30 bg-good/8 text-good",
  warning: "border-warning/30 bg-warning/8 text-warning",
  serious: "border-serious/30 bg-serious/8 text-serious",
  critical: "border-critical/30 bg-critical/8 text-critical",
  neutral: "border-border bg-ink/[0.02] text-ink-soft",
};

const ICONS: Record<IconName, Icon> = {
  check: CheckIcon,
  pause: PauseIcon,
  alert: WarningIcon,
  empty: ProhibitIcon,
  help: QuestionIcon,
  todo: CircleDashedIcon,
  risk: ShieldWarningIcon,
  safe: ShieldCheckIcon,
};

// A status is always a text label; the color is never the only signal. The
// icon is optional, for places where a pill stands alone rather than in a column.
export function Badge({ label, tone, icon, className = "" }: { label: string; tone: Tone; icon?: IconName; className?: string }) {
  const Glyph = icon ? ICONS[icon] : null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border py-[2px] pl-[7px] pr-2 text-[11.5px] font-semibold tabular-nums ${TONE_CLASSES[tone]} ${className}`}
      data-tone={tone}
    >
      {Glyph ? (
        <Glyph aria-hidden="true" weight="bold" className="size-3 shrink-0" />
      ) : (
        <span aria-hidden="true" className="size-[5px] shrink-0 bg-current" />
      )}
      {label}
    </span>
  );
}
