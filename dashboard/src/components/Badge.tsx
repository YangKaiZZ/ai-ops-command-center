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

// A soft pill in the tone's own color on a faint fill of it.
// Tailwind only sees class names written out in full, so each tone is spelled out.
const TONE_CLASSES: Record<Tone, string> = {
  good: "bg-good/12 text-good",
  warning: "bg-warning/13 text-warning",
  serious: "bg-serious/13 text-serious",
  critical: "bg-critical/13 text-critical",
  neutral: "bg-line text-neutral",
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
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-[3px] text-[11.5px] font-semibold tabular-nums ${Glyph ? "pl-2 pr-2.5" : "px-2.5"} ${TONE_CLASSES[tone]} ${className}`}
      data-tone={tone}
    >
      {Glyph && <Glyph aria-hidden="true" weight="bold" className="size-3 shrink-0" />}
      {label}
    </span>
  );
}
