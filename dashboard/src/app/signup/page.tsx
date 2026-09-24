"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { labelledInputClass, primaryButton } from "@/components/ui";
import { shopParam } from "@/lib/format";
import { saveSession, useSession } from "@/lib/session";

const MIN_PASSWORD = 8; // the backend's rule

// POST /api/auth/register -> JWT, then Settings to connect the store.
// Shopify's install link sends stores we don't know yet here with ?shop=.
function SignupForm() {
  const router = useRouter();
  const session = useSession();
  const shop = shopParam(useSearchParams().get("shop"));
  const signedUp = useRef(false); // set just before the session appears
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Signed in: go connect the store they came from, or finish setting up a new
  // account. Someone who was already signed in goes to the dashboard.
  useEffect(() => {
    if (!session) return;
    if (shop) router.replace(`/settings?connect=${encodeURIComponent(shop)}`);
    else router.replace(signedUp.current ? "/settings?welcome=1" : "/orders");
  }, [session, shop, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name: String(form.get("business_name")).trim(),
          email: String(form.get("email")).trim(),
          password: form.get("password"),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Sign-up failed");
      signedUp.current = true;
      saveSession({ token: body.token, business_name: body.business_name });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  const loginHref = shop ? `/login?shop=${encodeURIComponent(shop)}` : "/login";

  return (
    <form onSubmit={handleSubmit} className="grid w-full max-w-sm gap-3.5 rounded-xl border border-border bg-surface p-7">
      <h1 className="text-lg font-semibold">AI Ops Command Center</h1>
      <p className="text-sm text-ink-2">
        {shop ? (
          <>
            Create an account to finish installing on <span className="font-medium text-ink [overflow-wrap:anywhere]">{shop}</span>.
          </>
        ) : (
          "Create an account, then connect your Shopify store. The agent checks every new order and watches your stock."
        )}
      </p>
      <label className="grid gap-1.5 text-sm font-medium">
        Business name
        <input name="business_name" autoComplete="organization" required maxLength={255} className={labelledInputClass} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Email
        <input type="email" name="email" autoComplete="username" required className={labelledInputClass} />
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Password
        <input
          type="password"
          name="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          aria-describedby="password-hint"
          className={labelledInputClass}
        />
        <span id="password-hint" className="text-xs font-normal text-ink-2">
          At least {MIN_PASSWORD} characters.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting} className={primaryButton}>
        {submitting ? "Creating account…" : "Create account"}
      </button>
      <p className="text-center text-sm text-ink-2">
        Already have an account?{" "}
        <Link href={loginHref} className="font-medium text-accent underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function SignupPage() {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense>
        <SignupForm />
      </Suspense>
    </main>
  );
}
