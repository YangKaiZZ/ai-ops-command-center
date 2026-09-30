import Link from "next/link";

// Sellers are told which model reads their store before they connect it
// (PRODUCT.md): on sign-up and next to "Connect with Shopify".
export function DeepSeekNote({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-ink-2 ${className}`}>
      The agent runs on <span className="text-ink-soft">DeepSeek</span>, an AI provider based in China. It reads your orders and stock to make
      its calls; the{" "}
      <Link href="/privacy" className="underline hover:text-ink">
        privacy policy
      </Link>{" "}
      says exactly what it sees.
    </p>
  );
}
