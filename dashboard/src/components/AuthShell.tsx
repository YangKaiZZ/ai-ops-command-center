import Link from "next/link";
import { Lockup } from "./Logo";
import { focusRing } from "./ui";

// What the product does, in its own terms (PRODUCT.md): no customers, numbers
// or claims it can't back.
const POINTS = [
  { title: "A call on every order", text: "Fulfill, hold or restock, with the reason it made that call." },
  { title: "Checked by code, not just the model", text: "Stock comes from Shopify live, and a high fraud risk is a hold it can't overrule." },
  { title: "You stay in charge", text: "Shopify only changes when you act, or by a rule you turned on." },
];

// The signed-out pages (sign in, sign up, passwords): the brand panel on the
// left on wide screens, the form on the right. Phones get the form alone,
// with the lockup above it.
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside className="relative hidden overflow-hidden border-r border-line bg-sidebar lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-14">
        {/* A faint dot grid, the dashboard's "signal field". */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(rgb(236_238_230/0.09)_1px,transparent_1.2px)] [background-size:18px_18px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
        />
        <Link href="/login" aria-label="AI Ops Command Center" className={`relative w-fit rounded-lg ${focusRing}`}>
          <Lockup />
        </Link>
        <div className="relative max-w-xl">
          <p className="font-display text-[clamp(46px,4.9vw,76px)] font-bold leading-[0.95] tracking-[-0.03em]">
            It calls.
            <span className="block text-accent">You decide.</span>
          </p>
          <p className="mt-6 max-w-md text-[15px] leading-relaxed text-ink-soft">
            An operations agent for your Shopify store. It watches orders and stock, and tells you where you already are: email, Telegram or
            Slack, with the action one tap away.
          </p>
        </div>
        <ul className="relative grid gap-5 border-t border-line pt-8 xl:grid-cols-3">
          {POINTS.map((point) => (
            <li key={point.title} className="grid content-start gap-1.5">
              <span aria-hidden="true" className="h-[3px] w-5 bg-accent" />
              <span className="mt-1.5 text-sm font-semibold text-ink">{point.title}</span>
              <span className="text-[13px] leading-relaxed text-ink-2">{point.text}</span>
            </li>
          ))}
        </ul>
      </aside>
      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <Link href="/login" aria-label="AI Ops Command Center" className={`mb-10 block w-fit rounded-lg lg:hidden ${focusRing}`}>
            <Lockup />
          </Link>
          {children}
        </div>
      </main>
    </div>
  );
}

// The page's title and a line under it, above the form.
export function AuthTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-2 grid gap-2">
      <h1 className="font-display text-[27px] font-semibold leading-tight tracking-[-0.015em]">{title}</h1>
      {children && <div className="text-sm leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

// The pages an alert opens (act on an order, rate a call), mostly on a
// phone: the lockup over one centered card.
export function LinkPage({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-10">
      <Lockup small />
      {children}
    </main>
  );
}
