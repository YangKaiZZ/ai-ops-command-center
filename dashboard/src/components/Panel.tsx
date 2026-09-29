// A card: an Ink surface a step up from the page, a crisp edge, rounded corners.
export const card = "min-w-0 rounded-xl border border-border bg-surface";

// A titled card. `aside` sits on the right of the title (a link, a count);
// `sub` is a line under it.
export function Panel({
  title,
  sub,
  aside,
  id,
  className = "",
  children,
}: {
  title: string;
  sub?: React.ReactNode;
  aside?: React.ReactNode;
  id?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`${card} scroll-mt-20 p-4 sm:px-5 sm:py-4 ${className}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h2 className="font-display text-[16.5px] font-semibold tracking-[-0.015em]">{title}</h2>
          {sub && <div className="mt-0.5 text-[12.5px] text-ink-2">{sub}</div>}
        </div>
        {aside && <div className="text-[12.5px] text-ink-2">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-sm text-ink-2">{children}</p>;
}
