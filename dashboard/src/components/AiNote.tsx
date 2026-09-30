"use client";

import Link from "next/link";
import { providerFacts, useAiProvider } from "@/lib/aiProvider";

// Sellers are told which model reads their store before they connect it
// (PRODUCT.md): on sign-up and next to "Connect with Shopify". The provider
// comes from the server, so this stays true when the model is switched.
export function AiNote({ className = "" }: { className?: string }) {
  const ai = useAiProvider();
  if (ai === undefined) return null;
  const facts = ai ? providerFacts(ai) : null;

  return (
    <p className={`text-xs leading-relaxed text-ink-2 ${className}`}>
      {ai ? (
        <>
          The agent runs on <span className="text-ink-soft">{ai.name}</span>
          {facts ? `, an AI provider ${facts.where}` : ", an AI provider"}. It reads your orders and stock to make its calls.
          {facts ? ` ${facts.data}` : ""}
        </>
      ) : (
        <>The agent uses an AI model to read your orders and stock and make its calls.</>
      )}{" "}
      The{" "}
      <Link href="/privacy" className="underline hover:text-ink">
        privacy policy
      </Link>{" "}
      says exactly what it sees.
    </p>
  );
}
