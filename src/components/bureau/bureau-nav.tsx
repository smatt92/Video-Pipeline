import Link from 'next/link';

const ITEMS = [
  ['approvals', 'Approvals'],
  ['cuts', 'Cuts'],
  ['ready', 'Ready to schedule'],
  ['board', 'Board'],
  ['monitor', 'Generation'],
  ['calendar', 'Calendar'],
  ['metrics', 'Metrics'],
  ['authorship', 'Authorship log'],
] as const;

/** The control room's own tab row, so the phone never needs the sidebar. */
export function BureauNav({ active }: { active: (typeof ITEMS)[number][0] }) {
  return (
    <nav className="mb-4 flex gap-3 overflow-x-auto pb-1 text-sm" aria-label="Control room">
      {ITEMS.map(([slug, label]) => (
        <Link
          key={slug}
          href={`/bureau/${slug}`}
          className="whitespace-nowrap underline-offset-4"
          style={{ color: slug === active ? 'var(--accent)' : 'var(--text-muted)', textDecoration: slug === active ? 'underline' : 'none' }}
        >
          {label}
        </Link>
      ))}
      <Link href="/costs" className="whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
        Costs
      </Link>
    </nav>
  );
}
