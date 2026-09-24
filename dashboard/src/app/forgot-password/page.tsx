"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { labelledInputClass, primaryButton } from "@/components/ui";

// POST /api/auth/forgot-password: emails a reset link. The answer is the same
// for every address, so this page can't say whether an account exists.
function ForgotForm() {
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const prefilled = useSearchParams().get("email") ?? "";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email")).trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not send the reset link");
      setDone(body.message ?? "If that email has an account, a reset link is on its way.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid w-full max-w-sm gap-3.5 rounded-xl border border-border bg-surface p-7">
      <h1 className="text-lg font-semibold">Reset your password</h1>
      {done ? (
        <>
          <p role="status" className="text-sm text-ink-2">
            {done} Check your spam folder if it doesn&rsquo;t arrive in a few minutes.
          </p>
          <Link href="/login" className="text-center text-sm font-medium text-accent underline">
            Back to sign in
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-2">Enter your account&rsquo;s email and we&rsquo;ll send you a link to choose a new password.</p>
          <label className="grid gap-1.5 text-sm font-medium">
            Email
            <input type="email" name="email" autoComplete="username" defaultValue={prefilled} required className={labelledInputClass} />
          </label>
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting} className={primaryButton}>
            {submitting ? "Sending…" : "Send reset link"}
          </button>
          <p className="text-center text-sm text-ink-2">
            <Link href="/login" className="font-medium text-accent underline">
              Back to sign in
            </Link>
          </p>
        </>
      )}
    </form>
  );
}

export default function ForgotPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Suspense>
        <ForgotForm />
      </Suspense>
    </main>
  );
}
