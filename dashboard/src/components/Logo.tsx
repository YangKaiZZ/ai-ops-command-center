import { PulseIcon } from "@/components/icons";

// The mark: a pulse line on a lime-edged tile.
export function Logo() {
  return (
    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10 text-accent">
      <PulseIcon weight="bold" className="size-5" />
    </span>
  );
}
