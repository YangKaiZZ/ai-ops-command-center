import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Inter and JetBrains Mono (variable, Latin; SIL Open Font License, see
// fonts/) are kept in the repo, so builds need no network and pages make no
// requests to a font service.
const inter = localFont({ src: "./fonts/inter-latin-wght.woff2", weight: "100 900", display: "swap", variable: "--font-inter" });
const mono = localFont({
  src: "./fonts/jetbrains-mono-latin-wght.woff2",
  weight: "100 800",
  display: "swap",
  variable: "--font-jetbrains-mono",
  preload: false, // only small labels use it
});

export const metadata: Metadata = {
  title: "AI Ops Dashboard",
  description: "Orders, agent decisions, and low stock for your Shopify store.",
};

export const viewport: Viewport = {
  themeColor: "#13161c",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="font-sans text-[15px] leading-normal antialiased">{children}</body>
    </html>
  );
}
