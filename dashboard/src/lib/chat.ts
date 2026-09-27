// The Chat page's conversation: what's sent with each question, how replies
// are shown, and where the conversation is kept (this browser tab only).

export type ChatMessage = { role: "user" | "assistant"; content: string; tools?: string[] };
export type ChatStatus = { available: boolean; daily_limit: number; used_today: number };
export type ChatReply = { reply: string; tools_used: string[] };

export const MAX_SENT = 20; // the backend reads at most this many messages
export const MAX_QUESTION = 2000;

export const SUGGESTIONS = [
  "What needs to ship today?",
  "Which items run out this week, and how many should I reorder?",
  "Any orders flagged for fraud that still need a look?",
  "Which of the agent's calls did I mark wrong, and why?",
];

// What the tools read, in the seller's words ("Looked at pending orders, stock").
const TOOL_LABELS: Record<string, string> = {
  get_pending_orders: "orders to ship",
  get_all_orders: "orders",
  get_order: "an order",
  check_low_stock: "low stock",
  forecast_restock: "restock forecasts",
  get_decisions: "the agent's decisions",
};

export function toolsLine(tools: string[] | undefined): string | null {
  if (!tools?.length) return null;
  return `Looked at ${tools.map((t) => TOOL_LABELS[t] ?? t.replace(/_/g, " ")).join(", ")}`;
}

// The conversation to send: the last MAX_SENT messages, ending with the
// question, as role and text only.
export function toSend(history: ChatMessage[], question: string): { role: ChatMessage["role"]; content: string }[] {
  const all = [...history.map(({ role, content }) => ({ role, content })), { role: "user" as const, content: question }];
  const recent = all.slice(-MAX_SENT);
  // The backend wants the first message sent to be the seller's, like any chat.
  while (recent.length > 1 && recent[0].role !== "user") recent.shift();
  return recent;
}

// A reply split into text and order numbers (#1001), so each order number
// can link to the Orders page searched for it.
export type ReplyPart = { text: string; order?: string };
export function replyParts(text: string): ReplyPart[] {
  const parts: ReplyPart[] = [];
  let last = 0;
  for (const match of text.matchAll(/#\d{3,}/g)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: match[0], order: match[0] });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function ordersSearchHref(orderNumber: string): string {
  return `/orders?q=${encodeURIComponent(orderNumber)}`;
}

// "12 of 40 questions left today"
export function questionsLeft(status: ChatStatus | null): string | null {
  if (!status?.available) return null;
  const left = Math.max(0, status.daily_limit - status.used_today);
  return `${left} of ${status.daily_limit} question${status.daily_limit === 1 ? "" : "s"} left today`;
}

// The seller id inside the session token (its payload isn't secret), so one
// account's conversation never shows up for another signed in on this tab.
export function storageKey(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return `aiops.chat.${payload.sellerId}`;
  } catch {
    return "aiops.chat";
  }
}
