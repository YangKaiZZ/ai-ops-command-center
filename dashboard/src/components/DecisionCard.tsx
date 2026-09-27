import Link from "next/link";
import { Badge } from "@/components/Badge";
import { DecisionFeedback } from "@/components/DecisionFeedback";
import { card } from "@/components/Panel";
import { focusRing } from "@/components/ui";
import { canRate } from "@/lib/feedback";
import { actionInfo, parseReasoning, timeAgo } from "@/lib/format";
import type { Decision, SavedFeedback } from "@/lib/types";

type CardDecision = Pick<Decision, "id" | "action_taken" | "reasoning" | "created_at" | "feedback" | "feedback_note" | "feedback_at"> & {
  order_number?: string | null;
  order_id?: number | null;
};

// What to do about a verdict in Shopify, from the order's page.
const ACT_IN_SHOPIFY: Partial<Record<Decision["action_taken"], string>> = {
  fulfill: "Mark fulfilled in Shopify",
  hold: "Put on hold in Shopify",
};

// One agent decision as a card: verdict, what it was about, when, the
// reasoning, and the seller's rating of it (a skipped run has nothing to
// rate). With the order's id, the heading links to the order and a HOLD or
// FULFILL links to acting on it there.
export function DecisionCard({ decision, onFeedbackSaved }: { decision: CardDecision; onFeedbackSaved?: (saved: SavedFeedback) => void }) {
  const action = actionInfo(decision.action_taken);
  const { headline, blocks } = parseReasoning(decision.reasoning);
  const created = new Date(decision.created_at);
  const orderHref = decision.order_id ? `/orders/${decision.order_id}` : null;
  const kind = decision.order_number || decision.order_id ? "New order" : decision.action_taken === "low_stock_alert" ? "Low stock" : "Store event";
  const act = orderHref ? ACT_IN_SHOPIFY[decision.action_taken] : undefined;

  return (
    <li className={`${card} grid gap-2.5 px-[18px] py-4`} data-decision={decision.id}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <Badge label={action.label} tone={action.tone} />
        {decision.order_number || orderHref ? (
          orderHref ? (
            <Link href={orderHref} className={`font-mono text-[13.5px] font-semibold hover:text-accent ${focusRing}`}>
              {decision.order_number ?? `Order ${decision.order_id}`}
            </Link>
          ) : (
            <span className="font-mono text-[13.5px] font-semibold">{decision.order_number}</span>
          )
        ) : null}
        <span className="text-[12.5px] text-ink-2">
          {kind} ·{" "}
          <time dateTime={created.toISOString()} title={created.toLocaleString()}>
            {timeAgo(decision.created_at)}
          </time>
        </span>
        {decision.feedback && (
          <span className="ml-auto">
            <Badge label={decision.feedback === "up" ? "Marked right" : "Marked wrong"} tone={decision.feedback === "up" ? "good" : "critical"} />
          </span>
        )}
      </div>
      {headline && <p className="text-[13.5px] font-medium leading-normal">{headline}</p>}
      {blocks.length > 0 && (
        <div className="grid gap-1 text-[13px] leading-normal text-ink-soft">
          {blocks.map((block, i) =>
            block.type === "bullets" ? (
              <ul key={i} className="grid list-disc gap-0.5 pl-5">
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            ) : (
              <p key={i}>{block.text}</p>
            )
          )}
        </div>
      )}
      {act && (
        <Link href={`${orderHref}#in-shopify`} className={`w-fit text-[13px] font-medium text-accent hover:underline ${focusRing}`}>
          {act} →
        </Link>
      )}
      {canRate(decision.action_taken) && <DecisionFeedback decision={decision} onSaved={onFeedbackSaved} />}
    </li>
  );
}
