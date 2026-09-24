"use client";

import { useEffect, useState } from "react";
import { Panel } from "@/components/Panel";
import { secondaryButton } from "@/components/ui";
import { useApi } from "@/lib/useApi";

type DataRequest = {
  id: number;
  received_at: string;
  data_request_id: number | null;
  customer_id: number | null;
  order_ids: string[];
  data: { orders: { order_number: string | null }[]; decisions: unknown[] };
};

// Customer data requests Shopify forwards (GDPR). Only shown when there are any:
// each one lists the orders involved, with a download of what we hold.
export function PrivacySection() {
  const call = useApi();
  const [requests, setRequests] = useState<DataRequest[]>([]);

  useEffect(() => {
    let cancelled = false;
    call<{ requests: DataRequest[] }>("/api/settings/privacy-requests")
      .then(({ requests: list }) => !cancelled && setRequests(list))
      .catch(() => {}); // nothing to show is fine
    return () => {
      cancelled = true;
    };
  }, [call]);

  if (!requests.length) return null;

  function download(request: DataRequest) {
    const blob = new Blob([JSON.stringify(request.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customer-data-request-${request.data_request_id ?? request.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Panel title="Customer data requests">
      <div className="grid max-w-2xl gap-3">
        <p className="text-sm text-ink-2">
          A customer asked your store for the data held about them. Download what AI Ops holds and include it in your
          reply to them.
        </p>
        <ul className="grid gap-2">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-sm">
              <span className="font-medium">
                {r.data.orders.length
                  ? r.data.orders.map((o) => o.order_number).join(", ")
                  : `${r.order_ids.length} order${r.order_ids.length === 1 ? "" : "s"}, none stored here`}
              </span>
              <span className="text-ink-2">received {new Date(r.received_at).toLocaleDateString()}</span>
              <button type="button" onClick={() => download(r)} className={`${secondaryButton} ml-auto`}>
                Download data
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}
