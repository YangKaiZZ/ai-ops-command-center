"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDashboard } from "@/components/DashboardProvider";
import { card, Empty, Panel } from "@/components/Panel";
import { AlertsSection } from "@/components/settings/AlertsSection";
import { DeleteAccountSection } from "@/components/settings/DeleteAccountSection";
import { ApiKeysSection } from "@/components/settings/ApiKeysSection";
import { PrivacySection } from "@/components/settings/PrivacySection";
import { ReportsSection } from "@/components/settings/ReportsSection";
import { StockDefaultsSection } from "@/components/settings/StockDefaultsSection";
import { StoreSection } from "@/components/settings/StoreSection";
import { focusRing, PageHeader, type Message } from "@/components/ui";

// ?shopify=connected / ?shopify=error&message=... come back from Shopify's
// approval page; ?connect=<shop> and ?welcome come from sign-up.
function flashFrom(params: URLSearchParams): Message {
  if (params.get("shopify") === "connected") {
    return { text: "Store connected. Importing your orders and products now; they'll show up in a minute.", isError: false };
  }
  if (params.get("shopify") === "error") {
    return { text: params.get("message") || "Connecting to Shopify didn't work. Try again.", isError: true };
  }
  return null;
}

// The side menu: one link per section, lit for the one being read.
function SectionMenu({ sections }: { sections: { id: string; label: string }[] }) {
  const [current, setCurrent] = useState(sections[0]?.id);
  const ids = sections.map((s) => s.id).join(" ");

  useEffect(() => {
    // The section being read is the last one whose top has passed under the
    // top bar. At the very bottom, short sections never reach the top: there
    // it's the one jumped to (the #hash) if it's on screen, else the last one.
    let frame = 0;
    function update() {
      frame = 0;
      const els = ids.split(" ").flatMap((id) => document.getElementById(id) ?? []);
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      const onScreen = (el: HTMLElement) => el.getBoundingClientRect().top < window.innerHeight;
      const jumpedTo = els.find((el) => `#${el.id}` === window.location.hash);
      let el: HTMLElement | undefined;
      if (atBottom) el = jumpedTo && onScreen(jumpedTo) ? jumpedTo : els.filter(onScreen).pop();
      else el = els.filter((e) => e.getBoundingClientRect().top <= 120).pop();
      el ??= els[0];
      if (el) setCurrent(el.id);
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ids]);

  return (
    <nav aria-label="Settings sections" className="sticky top-24 hidden flex-col gap-0.5 self-start lg:flex">
      {sections.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={current === s.id ? "location" : undefined}
          className={`rounded-lg px-3 py-[9px] text-[13.5px] transition-colors ${focusRing} ${
            current === s.id ? "bg-field text-ink shadow-[inset_2px_0_0_var(--accent)]" : "text-ink-2 hover:bg-field/60 hover:text-ink"
          }`}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

// A section of the page, with room above it for the sticky top bar when jumped to.
function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div id={id} className="scroll-mt-24">
      {children}
    </div>
  );
}

function SettingsContent() {
  const { data, refresh, session } = useDashboard();
  const params = useSearchParams();
  const router = useRouter();
  // Read once, then tidy the URL so a reload doesn't repeat the message.
  const [flash] = useState(() => flashFrom(params));
  const [initialShop] = useState(() => params.get("connect") || "");
  const [welcome] = useState(() => params.has("welcome") || params.has("connect"));

  useEffect(() => {
    if (params.size) router.replace("/settings", { scroll: false });
  }, [params, router]);

  // The first import runs in the background after connecting; look again shortly.
  useEffect(() => {
    if (!flash || flash.isError) return;
    const timer = setTimeout(() => refresh().catch(() => {}), 5000);
    return () => clearTimeout(timer);
  }, [flash, refresh]);

  // A link to a section (#stock) lands before the sections have loaded; jump once they're here.
  const loaded = data !== null;
  useEffect(() => {
    if (loaded && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [loaded]);

  const header = <PageHeader title="Settings" />;
  if (!data) {
    return (
      <>
        {header}
        <Panel title="Settings">
          <Empty>Loading settings…</Empty>
        </Panel>
      </>
    );
  }
  const { settings } = data;
  const sections = [
    { id: "store", label: "Store" },
    { id: "alerts", label: "Alerts" },
    { id: "reports", label: "Summary & late orders" },
    { id: "stock", label: "Stock levels" },
    { id: "api-keys", label: "API keys" },
    { id: "privacy", label: "Customer data" },
    ...(settings.demo ? [] : [{ id: "account", label: "Account" }]),
  ];

  return (
    <>
      {header}
      <div className="grid gap-7 lg:grid-cols-[190px_minmax(0,1fr)]">
        <SectionMenu sections={sections} />
        <div className="grid max-w-3xl gap-4">
          {welcome && !settings.store.connected && (
            <section className={`${card} border-accent/30 p-4`}>
              <h2 className="font-display text-[16.5px] font-semibold tracking-[-0.015em]">Welcome{session.business_name ? `, ${session.business_name}` : ""}</h2>
              <p className="mt-1 text-sm text-ink-2">Two steps to get going: connect your Shopify store below, then choose where alerts should go.</p>
            </section>
          )}
          {settings.demo && (
            <p className={`${card} p-4 text-sm text-ink-2`}>
              In the demo, the settings that would reach outside it (connecting a store, alert channels, API keys, sending a summary) are turned
              off. The rest (auto-hold, the daily summary&rsquo;s hour, stock levels) can be changed.
            </p>
          )}
          <Section id="store">
            <StoreSection settings={settings} onChange={refresh} initialShop={initialShop} flash={flash} />
          </Section>
          <Section id="alerts">
            <AlertsSection settings={settings} onChange={refresh} />
          </Section>
          <Section id="reports">
            <ReportsSection settings={settings} onChange={refresh} />
          </Section>
          <Section id="stock">
            <StockDefaultsSection settings={settings} onChange={refresh} />
          </Section>
          <Section id="api-keys">
            <ApiKeysSection />
          </Section>
          <Section id="privacy">
            <PrivacySection />
          </Section>
          {!settings.demo && (
            <Section id="account">
              <DeleteAccountSection />
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

export default function SettingsPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense fallback={<Empty>Loading settings…</Empty>}>
      <SettingsContent />
    </Suspense>
  );
}
