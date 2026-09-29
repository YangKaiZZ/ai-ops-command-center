"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Lockup } from "@/components/Logo";

// The privacy policy. Everything here describes what the code does; who runs
// the server and how to reach them come from its settings (PRIVACY_OPERATOR,
// PRIVACY_CONTACT_EMAIL, via /api/auth/config). Change UPDATED with the text.
const UPDATED = "28 September 2026";

type Contact = { operator: string | null; contact_email: string | null };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2.5">
      <h2 className="font-display text-[16.5px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
      {children}
    </section>
  );
}

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="grid list-disc gap-1.5 pl-5 marker:text-ink-2/60">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function WhoRunsIt({ contact }: { contact: Contact | null }) {
  if (!contact) return <p>Loading…</p>;
  if (!contact.operator || !contact.contact_email) {
    return (
      <p className="rounded-lg border border-border bg-page px-3.5 py-2.5">
        The operator of this server hasn&rsquo;t published their name and contact address yet. Until they do, please don&rsquo;t connect a
        store you run for someone else.
      </p>
    );
  }
  return (
    <p>
      This service is run by <span className="font-medium text-ink">{contact.operator}</span>. For anything about your data, write to{" "}
      <a href={`mailto:${contact.contact_email}`} className="font-medium text-accent underline">
        {contact.contact_email}
      </a>
      .
    </p>
  );
}

export default function PrivacyPage() {
  const [contact, setContact] = useState<Contact | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/config")
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled) setContact(body.privacy ?? { operator: null, contact_email: null });
      })
      .catch(() => {
        if (!cancelled) setContact({ operator: null, contact_email: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto grid max-w-2xl gap-7 px-4 pb-16 pt-8 text-sm leading-relaxed text-ink-2">
      <header className="grid gap-4">
        <Link href="/login" aria-label="AI Ops Command Center" className="mb-4 w-fit text-ink">
          <Lockup small />
        </Link>
        <div className="grid gap-1">
          <h1 className="font-display text-[32px] font-semibold leading-tight tracking-[-0.03em] text-ink">Privacy policy</h1>
          <p className="font-mono text-xs">Last updated {UPDATED}</p>
        </div>
        <p>
          AI Ops Command Center connects to a Shopify store, watches its orders and stock, and has an AI agent recommend what to do
          (ship, hold, restock), with alerts where the seller chooses. This page says what it keeps, who else sees it, and for how long.
          &ldquo;You&rdquo; is the seller using it; &ldquo;customers&rdquo; are the people who buy from your store.
        </p>
      </header>

      <Section title="Who runs it">
        <WhoRunsIt contact={contact} />
      </Section>

      <Section title="What it keeps">
        <List
          items={[
            <>
              <span className="text-ink">Your account:</span> business name, email address, and your password as a one-way hash (bcrypt),
              never the password itself; your time zone and report settings.
            </>,
            <>
              <span className="text-ink">Your store connection:</span> the store&rsquo;s address, the permissions you granted, and
              Shopify&rsquo;s access tokens, encrypted.
            </>,
            <>
              <span className="text-ink">Where alerts go:</span> the email address you confirm, your Slack webhook (encrypted) and your
              Telegram chat id, only for the channels you turn on.
            </>,
            <>
              <span className="text-ink">From your store:</span> orders (number, shipping and payment status, total, when placed, and
              the items: product, variant, SKU, quantity, price), Shopify&rsquo;s fraud check on each order (risk level, recommendation,
              its reasons, and whether the billing and shipping addresses match), and stock levels. The customer&rsquo;s name is kept
              only when Shopify shares it with the app. Customers&rsquo; email addresses, phone numbers and postal addresses are not kept,
              and neither are notes or custom fields on items.
            </>,
            <>
              <span className="text-ink">What the app does:</span> the agent&rsquo;s recommendations and your ratings and notes on them;
              holds and fulfillments made from here, with the reason, note and tracking number.
            </>,
            <>
              <span className="text-ink">API keys</span> you create, only as a hash.
            </>,
            <>
              <span className="text-ink">Abuse protection:</span> counts of sign-in attempts and similar, stored as keyed hashes of the
              email or network address, not the address itself.
            </>,
          ]}
        />
      </Section>

      <Section title="Who else sees it">
        <List
          items={[
            <>
              <span className="text-ink">Shopify</span>, to read your orders and stock and, when you ask, to hold or ship orders.
            </>,
            <>
              <span className="text-ink">DeepSeek</span>, the AI model. For each new order or low-stock change, it gets the order&rsquo;s
              items, total, payment status, stock and fraud check, and your earlier ratings and notes; while it works it can look up
              other orders, which can include the customer&rsquo;s name when it&rsquo;s kept. When you use Chat, it gets your questions
              and what its tools read for them.
            </>,
            <>
              <span className="text-ink">Where you send alerts:</span> Slack, Telegram, or email (sent through the operator&rsquo;s email
              provider) get the alert text, which names orders and items.
            </>,
          ]}
        />
        <p>Nothing is sold or used for advertising, and there are no analytics or tracking scripts.</p>
      </Section>

      <Section title="In your browser">
        <p>
          Your sign-in is kept in the browser&rsquo;s local storage until you log out or it expires (7 days), and a Chat conversation in
          session storage until you close the tab. No cookies are set, and fonts are served from this site, not a third party.
        </p>
      </Section>

      <Section title="How long it's kept">
        <List
          items={[
            "Your account and store data: until you delete your account. Disconnecting the store stops syncing but keeps your history.",
            "When the app is uninstalled from your store, Shopify asks 48 hours later for the store's data to be deleted, and it is (your sign-in stays).",
            "Demo accounts are deleted after a few hours.",
            "Background job records: 30 days. Webhook delivery ids: 7 days. Abuse-protection counts: 1 day. Password reset links work for 1 hour.",
            "Technical logs (errors, sync results) stay for as long as the operator's server keeps them.",
          ]}
        />
      </Section>

      <Section title="Your choices, and your customers'">
        <List
          items={[
            <>
              Delete your account in <span className="text-ink">Settings</span>: the app is uninstalled from your store and everything
              above is deleted. A log of privacy requests (ids only) stays.
            </>,
            <>
              When a customer asks your store for their data, Shopify tells the app, and Settings shows what is kept about them for you
              to pass on. When a customer asks to be erased, their name is removed from their orders and from any text that mentions
              it, along with the reasons from the fraud check.
            </>,
            "Alert channels, API keys and the store connection can each be removed in Settings at any time.",
          ]}
        />
      </Section>

      <Section title="Security">
        <p>
          Connections use HTTPS. Shopify tokens and Slack webhooks are encrypted in the database; passwords, API keys and reset links
          are stored only as hashes. Links in alerts act on one order or decision and expire. Every account sees only its own data.
        </p>
      </Section>

      <Section title="Changes">
        <p>When this policy changes, the date at the top changes with it.</p>
      </Section>
    </main>
  );
}
