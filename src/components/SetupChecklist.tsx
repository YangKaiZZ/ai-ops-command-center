"use client";

import Link from "next/link";
import { Badge } from "./Badge";
import { Panel } from "./Panel";
import type { Settings } from "@/lib/types";

// What a new seller still has to do before the agent is useful. Disappears
// once the store is connected and at least one alert channel is on.
export function SetupChecklist({ settings }: { settings: Settings }) {
  const steps = [
    {
      done: settings.store.connected,
      title: "Connect your Shopify store",
      detail: "Brings in your orders and stock so the agent can check them.",
    },
    {
      done: settings.slack.connected || Boolean(settings.email_alerts.address) || settings.telegram.connected,
      title: "Choose where alerts go",
      detail: "Slack, email or Telegram: get told when an order can't ship or an item runs low.",
    },
  ];
  if (steps.every((s) => s.done)) return null;

  return (
    <Panel title="Get set up">
      <ol className="grid gap-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex flex-wrap items-start gap-3" data-step-done={step.done}>
            <span className="mt-0.5">
              {step.done ? <Badge label="Done" tone="good" icon="check" /> : <Badge label={`Step ${i + 1}`} tone="neutral" icon="empty" />}
            </span>
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className={`font-medium ${step.done ? "text-ink-2 line-through" : ""}`}>{step.title}</span>
              {!step.done && <span className="text-sm text-ink-2">{step.detail}</span>}
            </span>
            {!step.done && (
              <Link
                href="/settings"
                className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Open Settings
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
