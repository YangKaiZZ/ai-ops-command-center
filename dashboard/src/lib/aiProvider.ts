"use client";

import { useEffect, useState } from "react";

// Which AI provider reads a seller's store, from GET /api/auth/config -> ai.
// What we say about each provider is its published API data policy; the server
// only reports which one it runs.
export type AiProvider = { provider: string; name: string; model: string };

// `where` completes "<name>, an AI provider ..."; `data` says what happens to what it reads.
const FACTS: Record<string, { where: string; data: string }> = {
  openai: {
    where: "based in the US",
    data: "It doesn’t train on data sent through its API, and keeps abuse-monitoring logs for up to 30 days.",
  },
  deepseek: {
    where: "based in China",
    data: "It may train on what it reads, and stores it in China.",
  },
};

export function providerFacts(ai: AiProvider) {
  return FACTS[ai.provider] ?? null;
}

// undefined while loading, null when the server reports none (or can't be asked).
export function useAiProvider(): AiProvider | null | undefined {
  const [ai, setAi] = useState<AiProvider | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/config")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setAi(body.ai && typeof body.ai.name === "string" ? body.ai : null);
      })
      .catch(() => {
        if (!cancelled) setAi(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return ai;
}
