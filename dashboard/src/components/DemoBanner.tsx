import type { Settings } from "@/lib/types";

// Shown on every page of a "Try the demo" account: what it is, what works,
// and when it goes away.
export function DemoBanner({ demo }: { demo: NonNullable<Settings["demo"]> }) {
  const until = new Date(demo.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <section aria-label="About the demo" className="grid gap-1 rounded-lg border border-accent/25 bg-accent/10 px-3.5 py-2.5 text-sm">
      <p>
        <span className="font-semibold text-accent">You&rsquo;re trying the demo:</span> a sample store with made-up orders, fraud checks and
        the agent&rsquo;s decisions. Hold, release and fulfill work on each order&rsquo;s page, against a stand-in for Shopify.
      </p>
      <p className="text-ink-2">
        Connecting a real store, alert channels and API keys are off here, and the agent doesn&rsquo;t run. This demo is deleted at {until}.
      </p>
    </section>
  );
}
