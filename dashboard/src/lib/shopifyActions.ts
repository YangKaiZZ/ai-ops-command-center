import type { IconName, Tone } from "./format";
import type { FulfillmentOrderView, HoldReason, OrderAction } from "./types";

// Words for holding and fulfilling in Shopify (the order page's "In Shopify"
// panel and the auto-hold setting), kept apart so they can be tested.

export const HOLD_REASONS: [HoldReason, string][] = [
  ["HIGH_RISK_OF_FRAUD", "High risk of fraud"],
  ["INVENTORY_OUT_OF_STOCK", "Out of stock"],
  ["AWAITING_PAYMENT", "Awaiting payment"],
  ["INCORRECT_ADDRESS", "Incorrect address"],
  ["OTHER", "Other"],
];

export function holdReasonLabel(reason: string | null): string {
  return HOLD_REASONS.find(([value]) => value === reason)?.[1] ?? "Other";
}

// A fulfillment order's status as a badge.
export function fulfillmentStatus(status: string): { label: string; tone: Tone; icon: IconName } {
  switch (status) {
    case "open":
      return { label: "Not shipped", tone: "neutral", icon: "todo" };
    case "on_hold":
      return { label: "On hold", tone: "warning", icon: "pause" };
    case "scheduled":
      return { label: "Scheduled", tone: "neutral", icon: "todo" };
    case "in_progress":
      return { label: "In progress", tone: "neutral", icon: "todo" };
    case "closed":
      return { label: "Fulfilled", tone: "good", icon: "check" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", icon: "empty" };
    default:
      return { label: status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), tone: "warning", icon: "alert" };
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "2 of 3 items still to ship", "All 3 items shipped".
export function itemsToShip(fo: Pick<FulfillmentOrderView, "items">): string {
  const total = fo.items.reduce((sum, item) => sum + item.quantity, 0);
  const remaining = fo.items.reduce((sum, item) => sum + item.remaining, 0);
  if (remaining === 0) return total === 1 ? "Shipped" : `All ${total} items shipped`;
  if (remaining === total) return `${plural(total, "item")} to ship`;
  return `${remaining} of ${plural(total, "item")} still to ship`;
}

// One line of the log: who did what, and how it went.
export function describeAction(a: OrderAction): { who: string; text: string } {
  const who = a.source === "agent" ? "The agent" : "You";
  let text: string;
  if (a.action === "hold") text = `put it on hold (${holdReasonLabel(a.reason).toLowerCase()})${a.note ? `: ${a.note}` : ""}`;
  else if (a.action === "release") text = "released the hold";
  else text = `marked it fulfilled${a.note ? `, tracking ${a.note}` : ""}`;
  if (!a.ok) {
    const tried = a.action === "hold" ? "tried to put it on hold" : a.action === "release" ? "tried to release the hold" : "tried to mark it fulfilled";
    text = `${tried}, but it didn't work: ${a.error ?? "no reason given"}`;
  }
  return { who, text };
}

// What each Shopify permission is for, so "Missing permissions" says what
// stops working without it.
const SCOPE_USES: Record<string, string> = {
  read_orders: "orders",
  read_products: "products",
  read_inventory: "stock levels",
  write_merchant_managed_fulfillment_orders: "holding and fulfilling orders from here",
};

export function scopeUses(scopes: string[]): string {
  const uses = scopes.map((scope) => SCOPE_USES[scope] ?? scope);
  if (uses.length <= 1) return uses.join("");
  return `${uses.slice(0, -1).join(", ")} and ${uses.at(-1)}`;
}
