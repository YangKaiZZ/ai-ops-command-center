import { useSyncExternalStore } from "react";
import type { Session } from "./types";

// Same scheme as the original dashboard: the JWT from /api/auth/login, kept
// in localStorage under the same key. Storage can be unavailable (private
// windows, blocked site data), so every access is guarded.
const SESSION_KEY = "aiops.session";

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedSession: Session | null = null;
let signOutReason: "expired" | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

// useSyncExternalStore needs the same object back while nothing changed.
function getSnapshot(): Session | null {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      const value = JSON.parse(raw ?? "null");
      cachedSession = value?.token ? value : null;
    } catch {
      cachedSession = null;
    }
  }
  return cachedSession;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange); // sign-in/out in another tab
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

// The signed-in session, or null. On the server and during hydration it is
// always null, so the first client render matches the prerendered HTML.
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

export function loadSession(): Session | null {
  return getSnapshot();
}

export function saveSession(session: Session) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // The session just won't survive a reload.
  }
  notify();
}

export function clearSession(reason: "expired" | null = null) {
  signOutReason = reason;
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing stored.
  }
  notify();
}

// Why the last sign-out happened (read once, by whoever redirects to /login).
export function takeSignOutReason() {
  const reason = signOutReason;
  signOutReason = null;
  return reason;
}
