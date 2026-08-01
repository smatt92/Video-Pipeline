import Link from 'next/link';

import { ALL_NAV_ITEMS } from '@/lib/nav';

/**
 * The screen behind every route that exists in the inventory but is not built.
 *
 * States the phase and the actual blocker, not "coming soon". Someone landing here — via
 * a bookmark, a stale link, or the palette — should leave knowing whether the thing is
 * waiting on code, on a vendor, or on a two-to-four week external review that no amount
 * of engineering will shorten.
 */
export function NotBuiltYet({ href }: { href: string }) {
  const item = ALL_NAV_ITEMS.find((i) => i.href === href);
  const status = item?.status;

  return (
    <div className="flex min-h-full flex-col">
      <header
        className="flex items-center gap-3 border-b px-5"
        style={{ height: 'var(--topbar-height)', borderColor: 'var(--border-subtle)' }}
      >
        <h1 className="text-[14px] font-medium tracking-tight">{item?.label ?? 'Not built'}</h1>
      </header>

      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-[440px]">
          <div className="mb-3 flex items-center gap-2">
            <span
              aria-hidden
              className="size-[9px] rounded-xs"
              style={{ background: 'var(--surface-3)' }}
            />
            <span
              className="font-mono text-[10px] uppercase tracking-[0.09em]"
              style={{ color: 'var(--text-faint)' }}
            >
              {status?.kind === 'disabled' ? `phase ${status.phase}` : 'not built'}
            </span>
          </div>

          <p className="mb-2 text-[15px]" style={{ color: 'var(--text-primary)' }}>
            {item?.hint ?? 'This screen does not exist yet.'}
          </p>

          <p className="text-[13px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {status?.kind === 'disabled'
              ? status.reason
              : 'No reason recorded, which is itself a bug — every disabled route should say what it is waiting on.'}
          </p>

          <Link
            href="/"
            className="mt-6 inline-block text-[13px] underline underline-offset-4"
            style={{ color: 'var(--accent)' }}
          >
            Back to the board
          </Link>
        </div>
      </div>
    </div>
  );
}
