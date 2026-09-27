import { NAME_HIDDEN_NOTE, buyerLabel } from "@/lib/format";

// An order's customer, or a muted "Name not shared" explaining why on hover.
export function BuyerName({ name }: { name: string | null }) {
  const { text, hidden } = buyerLabel(name);
  if (!hidden) return <>{text}</>;
  return (
    <span className="text-ink-2" title={NAME_HIDDEN_NOTE}>
      {text}
    </span>
  );
}
