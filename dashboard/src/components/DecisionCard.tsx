import { Badge } from "@/components/Badge";
import { DecisionFeedback } from "@/components/DecisionFeedback";
import { canRate } from "@/lib/feedback";
import { actionInfo, parseReasoning, timeAgo } from "@/lib/format";
import type { Decision, SavedFeedback } from "@/lib/types";

type CardDecision = Pick<Decision, "id" | "action_taken" | "reasoning" | "created_at" | "feedback" | "feedback_note" | "feedback_at"> & {
  order_number?: string | null;
};

// One agent decision: verdict, what it was about, when, the reasoning, and
// the seller's rating of it (a skipped run has nothing to rate).
// On an order's own page the order is already known, so `title` can say something else.
export function DecisionCard({
  decision,
  title,
  onFeedbackSaved,
}: {
  decision: CardDecision;
  title?: string;
  onFeedbackSaved?: (saved: SavedFeedback) => void;
}) {
  const action = actionInfo(decision.action_taken);
  const { headline, blocks } = parseReasoning(decision.reasoning);
  const created = new Date(decision.created_at);
  const heading = title ?? (decision.order_number ? `Order ${decision.order_number}` : "Low-stock alert");

  return (
    <li className="grid gap-1.5 rounded-lg border border-hairline px-3.5 py-3" data-decision={decision.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={action.label} tone={action.tone} icon={action.icon} />
        {heading && <span className="font-semibold">{heading}</span>}
        <time className="ml-auto text-sm text-ink-2" dateTime={created.toISOString()} title={created.toLocaleString()}>
          {timeAgo(decision.created_at)}
        </time>
      </div>
      {headline && <p className="font-medium">{headline}</p>}
      <div className="grid gap-1 text-sm text-ink-2">
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
      {canRate(decision.action_taken) && <DecisionFeedback decision={decision} onSaved={onFeedbackSaved} />}
    </li>
  );
}
