import { DashboardProvider } from "@/components/DashboardProvider";
import { DashboardShell } from "@/components/DashboardShell";

// Everything in the (dashboard) group needs a signed-in seller.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardProvider>
      <DashboardShell>{children}</DashboardShell>
    </DashboardProvider>
  );
}
