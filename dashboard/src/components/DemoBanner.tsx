import type { Settings } from "@/lib/types";

// Shown on every page of a "Try the demo" account: what it is, what works,
// and when it goes away.
export function DemoBanner({ demo }: { demo: NonNullable<Settings["demo"]> }) {
  const until = new Date(demo.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <section aria-label="About the demo" className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-xl border border-border bg-surface px-4 py-3 text-sm">
      <span className="mt-px rounded-[5px] bg-ink-soft px-1.5 py-[3px] font-mono text-[11px] font-semibold uppercase leading-none tracking-[0.08em] text-on-accent">
        Sample store
      </span>
      <div className="grid min-w-0 flex-1 basis-80 gap-1">
        <p className="text-ink-soft">
          <span className="font-semibold text-ink">You&rsquo;re trying the demo:</span> a sample store with made-up orders, fraud checks and
          the agent&rsquo;s decisions. Hold, release and fulfill work on each order&rsquo;s page, against a stand-in for Shopify.
        </p>
        <p className="text-ink-2">
          Connecting a real store, alert channels and API keys are off here, and the agent doesn&rsquo;t run. This demo is deleted at {until}.
        </p>
      </div>
    </section>
  );
}
