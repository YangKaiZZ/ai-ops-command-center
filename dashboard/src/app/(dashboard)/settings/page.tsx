"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { AlertsSection } from "@/components/settings/AlertsSection";
import { ApiKeysSection } from "@/components/settings/ApiKeysSection";
import { PrivacySection } from "@/components/settings/PrivacySection";
import { ReportsSection } from "@/components/settings/ReportsSection";
import { StockDefaultsSection } from "@/components/settings/StockDefaultsSection";
import { StoreSection } from "@/components/settings/StoreSection";
import type { Message } from "@/components/ui";

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

  if (!data) {
    return (
      <Panel title="Settings">
        <Empty>Loading settings…</Empty>
      </Panel>
    );
  }
  const { settings } = data;

  return (
    <div className="grid gap-4">
      {welcome && !settings.store.connected && (
        <section className="rounded-xl border border-border bg-surface p-4">
          <h2 className="text-[15px] font-semibold">Welcome{session.business_name ? `, ${session.business_name}` : ""}</h2>
          <p className="mt-1 text-sm text-ink-2">
            Two steps to get going: connect your Shopify store below, then choose where alerts should go.
          </p>
        </section>
      )}
      <StoreSection settings={settings} onChange={refresh} initialShop={initialShop} flash={flash} />
      <AlertsSection settings={settings} onChange={refresh} />
      <ReportsSection settings={settings} onChange={refresh} />
      <StockDefaultsSection settings={settings} onChange={refresh} />
      <ApiKeysSection />
      <PrivacySection />
    </div>
  );
}

export default function SettingsPage() {
  return (
    // useSearchParams needs a Suspense boundary so the page can still prerender.
    <Suspense
      fallback={
        <Panel title="Settings">
          <Empty>Loading settings…</Empty>
        </Panel>
      }
    >
      <SettingsContent />
    </Suspense>
  );
}
