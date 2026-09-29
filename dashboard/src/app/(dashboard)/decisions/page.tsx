"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DecisionCard } from "@/components/DecisionCard";
import { useDashboard } from "@/components/DashboardProvider";
import { Logo } from "@/components/Logo";
import { card, Empty, Panel } from "@/components/Panel";
import { focusRing, PageHeader, secondaryButton, Tabs } from "@/components/ui";
import { accuracyPercent, DECISION_FILTERS, filterDecisions, type DecisionFilter } from "@/lib/feedback";
import { ACTIONS } from "@/lib/format";
import type { Action, Decision, Ratings } from "@/lib/types";

const RATED_VERDICTS: Exclude<Action, "skipped">[] = ["fulfill", "hold", "low_stock_alert", "unknown"];
// Tailwind only sees class names written out in full.
const VERDICT_BAR: Record<Exclude<Action, "skipped">, string> = {
  fulfill: "bg-good",
  hold: "bg-warning",
  low_stock_alert: "bg-serious",
  unknown: "bg-neutral",
};
const LEARNING_NOTES = 3;
// Calls shown at first, and added by each "Show more".
const PAGE = 15;

// How often the seller says the agent got it right, over every decision so far.
function Accuracy({ ratings }: { ratings: Ratings }) {
  const percent = accuracyPercent(ratings);
  const rated = ratings.up + ratings.down;
  const perVerdict = RATED_VERDICTS.filter((v) => ratings.by_verdict[v].up + ratings.by_verdict[v].down > 0);
  return (
    <section className={`${card} grid gap-3.5 px-5 py-[18px]`}>
      <h2 className="font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-ink-2">Agent accuracy</h2>
      {percent === null ? (
        <p className="text-[13px] leading-normal text-ink-soft">
          Rate each call with <span className="font-medium text-ink">Yes</span> or <span className="font-medium text-ink">No</span> to see how often the
          agent makes the right call.
        </p>
      ) : (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2.5">
            <span className="font-mono text-[34px] font-semibold leading-tight tracking-[-0.02em]">{percent}%</span>
            <span className="text-[12.5px] text-ink-2">
              {ratings.up} of {rated} rated right
            </span>
          </p>
          {perVerdict.map((v) => {
            const { up, down } = ratings.by_verdict[v];
            return (
              <div key={v} className="grid gap-1.5">
                <div className="flex justify-between text-[12.5px]">
                  <span>{ACTIONS[v].label}</span>
                  <span className="font-mono text-ink-2">
                    {up} of {up + down}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-sm bg-hairline" aria-hidden="true">
                  <div className={`h-full ${VERDICT_BAR[v]}`} style={{ width: `${(up / (up + down)) * 100}%` }} />
                </div>
              </div>
            );
          })}
          {ratings.unrated > 0 && <p className="text-[12.5px] text-ink-2">{ratings.unrated} not rated yet</p>}
        </>
      )}
    </section>
  );
}

// The seller's own notes, which the agent reads before similar calls.
function Learning({ decisions }: { decisions: Decision[] }) {
  const noted = decisions.filter((d) => d.feedback_note);
  return (
    <section className={`${card} grid gap-2.5 px-5 py-[18px]`}>
      <h2 className="flex items-center gap-2 font-display text-[15.5px] font-semibold tracking-[-0.005em]">
        <Logo className="size-4" />
        What it&rsquo;s learning
      </h2>
      <p className="text-[12.5px] leading-normal text-ink-2">
        Before each call, the agent reads your wrong calls and your notes on similar events from the last 90 days. A stock check always wins over a
        note.
      </p>
      {noted.length === 0 ? (
        <p className="text-[12.5px] leading-normal text-ink-soft">
          No notes yet. When you mark a call wrong, a few words on how your store works help it most.
        </p>
      ) : (
        <ul className="grid gap-2">
          {noted.slice(0, LEARNING_NOTES).map((d) => (
            <li key={d.id} className="rounded-lg border border-hairline bg-well px-3 py-2.5 text-[12.5px] leading-[1.45] text-ink-soft">
              &ldquo;{d.feedback_note}&rdquo;
              <span className="mt-1 block text-[11.5px] text-ink-2">
                {d.feedback === "down" ? "Marked wrong" : "Marked right"} · {ACTIONS[d.action_taken]?.label ?? "Call"}
                {d.order_number && ` on ${d.order_number}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {noted.length > LEARNING_NOTES && (
        <Link href="/decisions?show=wrong" className={`w-fit text-[12.5px] text-accent hover:underline ${focusRing}`}>
          See the calls marked wrong →
        </Link>
      )}
    </section>
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
  // How many calls are listed; back to one page whenever the filter changes
  // (a tab here resets it; a link to another filter starts at one page too).
  const [listed, setListed] = useState<{ show: DecisionFilter; count: number }>({ show, count: PAGE });
  const count = listed.show === show ? listed.count : PAGE;
  const keep = rated.show === show ? rated.ids : new Set<number>();
  const setShow = (next: DecisionFilter) => {
    setListed({ show: next, count: PAGE });
    router.replace(next === "all" ? "/decisions" : `/decisions?show=${next}`, { scroll: false });
  };

  const header = <PageHeader title="Decisions" sub="Every call the agent made. Rate them: it learns from your notes." />;
  if (!data) {
    return (
      <>
        {header}
        <Panel title="Decisions">
          <Empty>Loading decisions…</Empty>
        </Panel>
      </>
    );
  }

  const decisions = filterDecisions(data.decisions, show, keep);
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
    <>
      {header}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid gap-3.5">
          <Tabs
            label="Show"
            active={show}
            onSelect={setShow}
            tabs={[
              { key: "all", label: "All", count: data.decisions.length },
              { key: "unrated", label: "Not rated", count: filterDecisions(data.decisions, "unrated").length },
              { key: "wrong", label: "Marked wrong", count: filterDecisions(data.decisions, "wrong").length },
            ]}
          />
          {decisions.length === 0 ? (
            <div className={`${card} px-5 py-4`}>
              <Empty>{emptyText}</Empty>
            </div>
          ) : (
            <>
              <ol className="grid gap-3.5">
                {decisions.slice(0, count).map((decision) => (
                  <DecisionCard key={decision.id} decision={decision} onFeedbackSaved={onFeedbackSaved} />
                ))}
              </ol>
              <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-[13px] text-ink-2">
                <span>
                  Showing {Math.min(count, decisions.length)} of {decisions.length}
                </span>
                {decisions.length > count && (
                  <button type="button" onClick={() => setListed({ show, count: count + PAGE })} className={secondaryButton}>
                    Show {Math.min(PAGE, decisions.length - count)} more
                  </button>
                )}
              </div>
            </>
          )}
        </div>
        <aside className="grid gap-4 max-lg:row-start-1 lg:sticky lg:top-24">
          <Accuracy ratings={data.ratings} />
          <Learning decisions={data.decisions} />
        </aside>
      </div>
    </>
  );
}

export default function DecisionsPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense fallback={<Empty>Loading decisions…</Empty>}>
      <DecisionsView />
    </Suspense>
  );
}
