"use client";

import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { actionInfo, parseReasoning, timeAgo } from "@/lib/format";
import type { Decision } from "@/lib/types";

function DecisionCard({ decision }: { decision: Decision }) {
  const action = actionInfo(decision.action_taken);
  const { headline, blocks } = parseReasoning(decision.reasoning);
  const created = new Date(decision.created_at);

  return (
    <li className="grid gap-1.5 rounded-lg border border-hairline px-3.5 py-3" data-decision={decision.id}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge label={action.label} tone={action.tone} icon={action.icon} />
        <span className="font-semibold">
          {decision.order_number ? `Order ${decision.order_number}` : "Low-stock alert"}
        </span>
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
    </li>
  );
}

export default function DecisionsPage() {
  const { data } = useDashboard();

  return (
    <Panel title="Decisions log">
      {!data ? (
        <Empty>Loading decisions…</Empty>
      ) : data.decisions.length === 0 ? (
        <Empty>No decisions yet. The agent adds one whenever an order comes in or stock runs low.</Empty>
      ) : (
        <ol className="grid gap-2.5">
          {data.decisions.map((decision) => (
            <DecisionCard key={decision.id} decision={decision} />
          ))}
        </ol>
      )}
    </Panel>
  );
}
