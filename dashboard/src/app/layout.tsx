import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Ops Dashboard",
  description: "Orders, agent decisions, and low stock for your Shopify store.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="font-sans text-[15px] leading-normal antialiased">{children}</body>
    </html>
  );
}
