"use client";

import { DecisionCard } from "@/components/DecisionCard";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";

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
