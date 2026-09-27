import { LightningIcon } from "@/components/icons";

// The mark: a lightning bolt on a solid lime tile.
export function Logo() {
  return (
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-accent text-on-accent">
      <LightningIcon weight="fill" className="size-[18px]" />
    </span>
  );
}
