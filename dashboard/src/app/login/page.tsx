"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { labelledInputClass, primaryButton } from "@/components/ui";
import { shopParam } from "@/lib/format";
import { saveSession, useSession } from "@/lib/session";

// Same sign-in as the original dashboard: POST /api/auth/login -> JWT.
function LoginForm() {
  const router = useRouter();
  const session = useSession();
  const params = useSearchParams();
  const expired = params.has("expired");
  // Came from Shopify's install link via sign-up: connect that store next.
  const shop = shopParam(params.get("shop"));
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in (including right after a successful sign-in).
  useEffect(() => {
    if (session) router.replace(shop ? `/settings?connect=${encodeURIComponent(shop)}` : "/orders");
  }, [session, shop, router]);

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
  const signupHref = shop ? `/signup?shop=${encodeURIComponent(shop)}` : "/signup";

  return (
    <form onSubmit={handleSubmit} className="grid w-full max-w-sm gap-3.5 rounded-xl border border-border bg-surface p-7">
      <h1 className="text-lg font-semibold">AI Ops Command Center</h1>
      <p className="text-sm text-ink-2">Sign in to see your store&rsquo;s orders and what the agent decided.</p>
      <label className="grid gap-1.5 text-sm font-medium">
        Email
        <input type="email" name="email" autoComplete="username" required className={labelledInputClass} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Password
        <input type="password" name="password" autoComplete="current-password" required className={labelledInputClass} />
      </label>
      {message && (
        <p role="alert" className="text-sm text-error">
          {message}
        </p>
      )}
      <button type="submit" disabled={submitting} className={primaryButton}>
        {submitting ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-center text-sm text-ink-2">
        <Link href="/forgot-password" className="font-medium text-accent underline">
          Forgot your password?
        </Link>
      </p>
      <p className="text-center text-sm text-ink-2">
        New here?{" "}
        <Link href={signupHref} className="font-medium text-accent underline">
          Create an account
        </Link>
      </p>
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
