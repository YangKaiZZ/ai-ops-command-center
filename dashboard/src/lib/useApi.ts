"use client";

import { useCallback } from "react";
import { useDashboard } from "@/components/DashboardProvider";
import { apiFetch, UnauthorizedError } from "./api";
import { clearSession } from "./session";

// apiFetch with the signed-in seller's token. A 401 anywhere ends the session
// and sends the seller back to sign-in, like the rest of the dashboard.
export function useApi() {
  const { session } = useDashboard();
  const token = session.token;
  return useCallback(
    async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      try {
        return await apiFetch<T>(path, token, init);
      } catch (err) {
        if (err instanceof UnauthorizedError) clearSession("expired");
        throw err;
      }
    },
    [token]
  );
}

// A JSON request body for apiFetch.
export function jsonBody(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
