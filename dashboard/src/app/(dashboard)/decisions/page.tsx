"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DecisionCard } from "@/components/DecisionCard";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { accuracyPercent, DECISION_FILTERS, filterDecisions, type DecisionFilter } from "@/lib/feedback";
import { ACTIONS } from "@/lib/format";
import type { Action, Ratings } from "@/lib/types";

const RATED_VERDICTS: Exclude<Action, "skipped">[] = ["fulfill", "hold", "low_stock_alert", "unknown"];

// How often the seller says the agent got it right, over every decision so far.
function Accuracy({ ratings }: { ratings: Ratings }) {
  const percent = accuracyPercent(ratings);
  if (percent === null) {
    return (
      <p className="text-sm text-ink-2">
        Rate each decision with <span className="font-medium text-ink">Yes</span> or <span className="font-medium text-ink">No</span> to see how
        often the agent makes the right call.
      </p>
    );
  }
  const rated = ratings.up + ratings.down;
  const perVerdict = RATED_VERDICTS.filter((v) => ratings.by_verdict[v].up + ratings.by_verdict[v].down > 0);
  return (
    <div className="grid gap-1">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums">{percent}%</span>
        <span className="text-sm text-ink-2">
          right, from <span className="tabular-nums">{rated}</span> rated ({ratings.up} right, {ratings.down} wrong)
          {ratings.unrated > 0 && `; ${ratings.unrated} not rated yet`}
        </span>
      </p>
      {perVerdict.length > 1 && (
        <p className="text-sm text-ink-2">
          {perVerdict.map((v, i) => {
            const { up, down } = ratings.by_verdict[v];
            return (
              <span key={v}>
                {i > 0 && " · "}
                {ACTIONS[v].label} <span className="tabular-nums">{up} of {up + down}</span> right
              </span>
            );
          })}
        </p>
      )}
    </div>
  );
}

function DecisionsView() {
  const { data, refresh } = useDashboard();
  const router = useRouter();
  // The filter is kept in the URL (?show=unrated), so it survives a reload.
  const shown = useSearchParams().get("show");
  const show: DecisionFilter = DECISION_FILTERS.includes(shown as DecisionFilter) ? (shown as DecisionFilter) : "all";
  // Decisions rated since this filter was picked stay in view (see filterDecisions).
  const [rated, setRated] = useState<{ show: DecisionFilter; ids: Set<number> }>({ show, ids: new Set() });
  const keep = rated.show === show ? rated.ids : new Set<number>();
  const setShow = (next: DecisionFilter) => router.replace(next === "all" ? "/decisions" : `/decisions?show=${next}`, { scroll: false });

  if (!data) {
    return (
      <Panel title="Decisions log">
        <Empty>Loading decisions…</Empty>
      </Panel>
    );
  }

  const decisions = filterDecisions(data.decisions, show, keep);
  const filters = [
    { key: "all" as const, label: "All", count: data.decisions.length },
    { key: "unrated" as const, label: "Not rated", count: filterDecisions(data.decisions, "unrated").length },
    { key: "wrong" as const, label: "Marked wrong", count: filterDecisions(data.decisions, "wrong").length },
  ];
  const emptyText = {
    all: "No decisions yet. The agent adds one whenever an order comes in or stock runs low.",
    unrated: "Every decision here has been rated.",
    wrong: "None marked wrong.",
  }[show];
  const onFeedbackSaved = ({ id }: { id: number }) => {
    setRated((r) => ({ show, ids: new Set(r.show === show ? r.ids : []).add(id) }));
    refresh();
  };

  return (
    <Panel title="Decisions log">
      <div className="grid gap-4">
        {data.decisions.length > 0 && <Accuracy ratings={data.ratings} />}
        {data.decisions.length > 0 && (
          <div role="group" aria-label="Show" className="flex w-fit flex-wrap gap-1 rounded-lg border border-hairline p-0.5">
            {filters.map((f) => (
              <button
                key={f.key}
                type="button"
                aria-pressed={show === f.key}
                onClick={() => setShow(f.key)}
                className={`rounded-md px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  show === f.key ? "bg-ink/8 text-ink" : "text-ink-2 hover:text-ink"
                }`}
              >
                {f.label} <span className="tabular-nums text-ink-2">{f.count}</span>
              </button>
            ))}
          </div>
        )}
        {decisions.length === 0 ? (
          <Empty>{emptyText}</Empty>
        ) : (
          <ol className="grid gap-2.5">
            {decisions.map((decision) => (
              <DecisionCard key={decision.id} decision={decision} onFeedbackSaved={onFeedbackSaved} />
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}

export default function DecisionsPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense
      fallback={
        <Panel title="Decisions log">
          <Empty>Loading decisions…</Empty>
        </Panel>
      }
    >
      <DecisionsView />
    </Suspense>
  );
}
