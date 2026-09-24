"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { labelledInputClass, primaryButton } from "@/components/ui";

const MIN_PASSWORD = 8; // the backend's rule

// The page an emailed link opens: POST /api/auth/reset-password with the token
// from the link and a new password. It doesn't sign in; the next step is sign-in.
function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirm"))) {
      setError("The two passwords don't match");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not reset the password");
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="grid w-full max-w-sm gap-3.5 rounded-xl border border-border bg-surface p-7">
        <h1 className="text-lg font-semibold">Password changed</h1>
        <p role="status" className="text-sm text-ink-2">
          Your password is changed and you&rsquo;re signed out everywhere else. Sign in with the new one.
        </p>
        <Link href="/login" className={`${primaryButton} text-center`}>
          Sign in
        </Link>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="grid w-full max-w-sm gap-3.5 rounded-xl border border-border bg-surface p-7">
        <h1 className="text-lg font-semibold">Reset your password</h1>
        <p className="text-sm text-ink-2">This page needs the link from your reset email. Open it from there, or ask for a new one.</p>
        <Link href="/forgot-password" className="text-center text-sm font-medium text-accent underline">
          Send me a reset link
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid w-full max-w-sm gap-3.5 rounded-xl border border-border bg-surface p-7">
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <label className="grid gap-1.5 text-sm font-medium">
        New password
        <input type="password" name="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={200} className={labelledInputClass} />
        <span className="text-xs font-normal text-ink-2">At least {MIN_PASSWORD} characters.</span>
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Repeat it
        <input type="password" name="confirm" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={200} className={labelledInputClass} />
      </label>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}{" "}
          {/invalid or has expired/.test(error) && (
            <Link href="/forgot-password" className="font-medium underline">
              Ask for a new link
            </Link>
          )}
        </p>
      )}
      <button type="submit" disabled={submitting} className={primaryButton}>
        {submitting ? "Saving…" : "Change password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <Suspense>
        <ResetForm />
      </Suspense>
    </main>
  );
}
