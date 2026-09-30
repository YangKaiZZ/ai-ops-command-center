"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthShell, AuthTitle } from "@/components/AuthShell";
import { AiNote } from "@/components/AiNote";
import { labelledInputClass, primaryButton } from "@/components/ui";
import { shopParam } from "@/lib/format";
import { saveSession, useSession } from "@/lib/session";

const MIN_PASSWORD = 8; // the backend's rule
// What the backend's install tickets look like (services/installTickets.js).
const TICKET = /^\d{1,12}\.[A-Za-z0-9_-]{43}$/;

// Asks for the store's approval URL (POST /api/shopify/connect), or null.
async function approvalUrl(token: string, shop: string): Promise<string | null> {
  try {
    const res = await fetch("/api/shopify/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ shop }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok && typeof body.authorize_url === "string" ? body.authorize_url : null;
  } catch {
    return null;
  }
}

// POST /api/auth/register -> JWT, then Settings to connect the store.
// Shopify's install link sends stores we don't know yet here with ?shop= and
// an install ticket (?install=), which stands in for the invite code; the
// store is then connected right away: the app is already installed, so
// Shopify's approval sends the seller straight back, connected.
function SignupForm() {
  const router = useRouter();
  const session = useSession();
  const params = useSearchParams();
  const shop = shopParam(params.get("shop"));
  const ticket = shop && TICKET.test(params.get("install") ?? "") ? (params.get("install") as string) : "";
  const signedUp = useRef(false); // set just before the session appears
  const leaving = useRef(false); // on the way to Shopify: don't redirect here
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState<"" | "account" | "shopify">("");
  // Whether the server wants an invite code (SIGNUP_INVITE_CODE). If we can't ask, don't show the field: the server still enforces it.
  const [inviteRequired, setInviteRequired] = useState(false);

  useEffect(() => {
    fetch("/api/auth/config")
      .then((res) => res.json())
      .then((body) => setInviteRequired(body.invite_required === true))
      .catch(() => {});
  }, []);

  // Signed in: go connect the store they came from, or finish setting up a new
  // account. Someone who was already signed in goes to the dashboard.
  useEffect(() => {
    if (!session || leaving.current) return;
    if (shop) router.replace(`/settings?connect=${encodeURIComponent(shop)}`);
    else router.replace(signedUp.current ? "/settings?welcome=1" : "/overview");
  }, [session, shop, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setSubmitting("account");
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name: String(form.get("business_name")).trim(),
          email: String(form.get("email")).trim(),
          password: form.get("password"),
          invite_code: inviteRequired && !ticket ? String(form.get("invite_code")).trim() : undefined,
          ...(ticket ? { shop, install_ticket: ticket } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Sign-up failed");
      signedUp.current = true;
      if (shop) {
        setSubmitting("shopify");
        const url = await approvalUrl(body.token, shop);
        if (url) {
          leaving.current = true;
          saveSession({ token: body.token, business_name: body.business_name });
          window.location.assign(url);
          return;
        }
      }
      // No store yet, or Shopify's approval couldn't start: Settings takes it from here.
      saveSession({ token: body.token, business_name: body.business_name });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting("");
    }
  }

  const loginHref = shop ? `/login?shop=${encodeURIComponent(shop)}` : "/login";

  return (
    <form onSubmit={handleSubmit} className="grid w-full gap-3.5">
      <AuthTitle title="Create your account">
        {shop ? (
          <>
            Create an account to finish installing on <span className="font-medium text-ink [overflow-wrap:anywhere]">{shop}</span>. Your
            store connects right after, and its orders and stock come in by themselves.
          </>
        ) : (
          "Create an account, then connect your Shopify store. The agent checks every new order and watches your stock."
        )}
      </AuthTitle>
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
      {inviteRequired && !ticket && (
        <label className="grid gap-1.5 text-sm font-medium">
          Invite code
          <input name="invite_code" autoComplete="off" required className={labelledInputClass} />
          <span className="text-xs font-normal text-ink-2">Sign-up is invite-only for now. Use the code you were given.</span>
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <AiNote />
      <button type="submit" disabled={submitting !== ""} className={primaryButton}>
        {submitting === "shopify" ? "Connecting your store…" : submitting ? "Creating account…" : shop ? "Create account and connect" : "Create account"}
      </button>
      <p className="text-center text-sm text-ink-2">
        Already have an account?{" "}
        <Link href={loginHref} className="font-medium text-accent underline">
          Sign in
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

export default function SignupPage() {
  return (
    <AuthShell>
      {/* useSearchParams needs a Suspense boundary so the page can still prerender. */}
      <Suspense>
        <SignupForm />
      </Suspense>
    </AuthShell>
  );
}
