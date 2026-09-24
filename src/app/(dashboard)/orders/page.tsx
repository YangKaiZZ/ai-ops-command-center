"use client";

import { Badge } from "@/components/Badge";
import { useDashboard } from "@/components/DashboardProvider";
import { Empty, Panel } from "@/components/Panel";
import { actionInfo, formatMoney } from "@/lib/format";

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full border border-hairline px-2 text-xs text-ink-2">{children}</span>
  );
}

export default function OrdersPage() {
  const { data } = useDashboard();

  return (
    <Panel title="Orders">
      {!data ? (
        <Empty>Loading orders…</Empty>
      ) : data.orders.length === 0 ? (
        <Empty>No orders synced yet. Use “Sync from Shopify”.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs font-semibold text-ink-2">
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Order</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Customer</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3 text-right">Total</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Shipping</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Payment</th>
                <th scope="col" className="whitespace-nowrap pb-2 pr-3">Placed</th>
                <th scope="col" className="whitespace-nowrap pb-2">Agent verdict</th>
              </tr>
            </thead>
            <tbody>
              {data.orders.map((order) => {
                const decision = data.latestByOrder.get(order.id);
                const action = decision && actionInfo(decision.action_taken);
                const placed = order.order_placed_at ? new Date(order.order_placed_at) : null;
                return (
                  <tr key={order.id} className="border-b border-hairline last:border-0" data-order={order.order_number ?? ""}>
                    <td className="py-2.5 pr-3 font-semibold">{order.order_number ?? "—"}</td>
                    <td className="py-2.5 pr-3">{order.buyer_name || "Guest"}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">{formatMoney(order.total_amount)}</td>
                    <td className="py-2.5 pr-3"><Chip>{order.status || "—"}</Chip></td>
                    <td className="py-2.5 pr-3"><Chip>{order.financial_status || "—"}</Chip></td>
                    <td className="whitespace-nowrap py-2.5 pr-3" title={placed?.toLocaleString()}>
                      {placed ? placed.toLocaleDateString() : "—"}
                    </td>
                    <td className="py-2.5">
                      {action ? (
                        <Badge label={action.label} tone={action.tone} icon={action.icon} />
                      ) : (
                        <span className="text-sm text-ink-2">No decision</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
