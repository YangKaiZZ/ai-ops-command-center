"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthShell, AuthTitle } from "@/components/AuthShell";
import { focusRing, labelledInputClass, primaryButton, secondaryButton } from "@/components/ui";
import { shopParam } from "@/lib/format";
import { saveSession, useSession } from "@/lib/session";

// Same sign-in as the original dashboard: POST /api/auth/login -> JWT.
function LoginForm() {
  const router = useRouter();
  const session = useSession();
  const params = useSearchParams();
  const expired = params.has("expired");
  const deleted = params.has("deleted");
  // Came from Shopify's install link via sign-up: connect that store next.
  const shop = shopParam(params.get("shop"));
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // "Try the demo": a sample store of your own, no account needed (when the server offers it).
  const [demoAvailable, setDemoAvailable] = useState(false);
  const [demoStarting, setDemoStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/config")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setDemoAvailable(body.demo_available === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function startDemo() {
    setError("");
    setSubmitted(true);
    setDemoStarting(true);
    try {
      const res = await fetch("/api/auth/demo", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't start the demo");
      saveSession({ token: body.token, business_name: body.business_name });
    } catch (err) {
      setError((err as Error).message);
      setDemoStarting(false);
    }
  }

  // Already signed in (including right after a successful sign-in).
  useEffect(() => {
    if (session) router.replace(shop ? `/settings?connect=${encodeURIComponent(shop)}` : "/overview");
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

  const message =
    error ||
    (!submitted && expired ? "Your session expired. Sign in again." : "") ||
    (!submitted && deleted ? "Your account and its data were deleted." : "");
  const signupHref = shop ? `/signup?shop=${encodeURIComponent(shop)}` : "/signup";

  return (
    <form onSubmit={handleSubmit} className="grid w-full gap-3.5">
      <AuthTitle title="Sign in">Sign in to see your store&rsquo;s orders and what the agent decided.</AuthTitle>
      <label className="grid gap-1.5 text-sm font-medium">
        Email
        <input type="email" name="email" autoComplete="username" required className={labelledInputClass} />
      </label>
      <div className="grid gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <Link href="/forgot-password" className={`rounded text-[13px] text-ink-2 hover:text-ink hover:underline ${focusRing}`}>
            Forgot it?
          </Link>
        </div>
        <input id="password" type="password" name="password" autoComplete="current-password" required className={labelledInputClass} />
      </div>
      {message && (
        <p role={error || expired ? "alert" : "status"} className={`text-sm ${error || expired ? "text-error" : "text-ink-2"}`}>
          {message}
        </p>
      )}
      <button type="submit" disabled={submitting || demoStarting} className={primaryButton}>
        {submitting ? "Signing in…" : "Sign in"}
      </button>
      {demoAvailable && (
        <div className="grid gap-2 border-t border-hairline pt-3.5">
          <button type="button" onClick={startDemo} disabled={submitting || demoStarting} className={secondaryButton}>
            {demoStarting ? "Setting up a sample store…" : "Try the demo"}
          </button>
          <p className="text-center text-xs text-ink-2">A sample store of your own, no account needed. It&rsquo;s deleted after a few hours.</p>
        </div>
      )}
      <p className="mt-2 text-center text-sm text-ink-2">
        New here?{" "}
        <Link href={signupHref} className="font-medium text-accent underline">
          Create an account
        </Link>
      </p>
      <p className="text-center text-xs text-ink-2">
        <Link href="/privacy" className="underline hover:text-ink">
          Privacy policy
        </Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <AuthShell>
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
