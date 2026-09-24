"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { saveSession, useSession } from "@/lib/session";

const inputClass =
  "rounded-lg border border-hairline bg-page px-3 py-2 font-normal text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// Same sign-in as the original dashboard: POST /api/auth/login -> JWT.
function LoginForm() {
  const router = useRouter();
  const session = useSession();
  const expired = useSearchParams().has("expired");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in (including right after a successful sign-in).
  useEffect(() => {
    if (session) router.replace("/orders");
  }, [session, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setSubmitted(true);
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email")).trim(), password: form.get("password") }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Sign-in failed");
      saveSession({ token: body.token, business_name: body.business_name });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const message = error || (expired && !submitted ? "Your session expired. Sign in again." : "");

  return (
    <form onSubmit={handleSubmit} className="grid w-full max-w-sm gap-3.5 rounded-xl border border-border bg-surface p-7">
      <h1 className="text-lg font-semibold">AI Ops Command Center</h1>
      <p className="text-sm text-ink-2">Sign in to see your store&rsquo;s orders and what the agent decided.</p>
      <label className="grid gap-1.5 text-sm font-medium">
        Email
        <input type="email" name="email" autoComplete="username" required className={inputClass} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Password
        <input type="password" name="password" autoComplete="current-password" required className={inputClass} />
      </label>
      {message && (
        <p role="alert" className="text-sm text-error">
          {message}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-progress disabled:opacity-60"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
