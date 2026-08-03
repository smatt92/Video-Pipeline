import Link from 'next/link';

import { deferralState } from '@/lib/onboarding/deferred';

/**
 * The persistent banner naming what was deferred and what is inert because of it.
 *
 * Persistent on purpose, and not dismissible. A dismissible banner is dismissed on the
 * first day and the state it describes then becomes invisible for weeks — which is the
 * exact failure this exists to prevent, since a deferred integration looks identical to a
 * working one from every screen that has no data to show anyway.
 *
 * It says three things, because two of them are the ones people get wrong:
 *   what is deferred, and the reason given at the time;
 *   that it is NOT complete — the gate opened, nothing became usable;
 *   where to go to finish it.
 */
export async function DeferralBanner() {
  const state = await deferralState();

  if (state.unavailable) {
    return (
      <div
        className="border-b px-5 py-2 text-[11.5px]"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--surface-inset)',
          color: 'var(--text-faint)',
        }}
        data-deferral="unreadable"
      >
        Deferred-step status could not be read ({state.unavailable}). If migrations are
        outstanding this banner cannot tell you what is inert — run{' '}
        <code className="font-mono">pnpm doctor</code>.
      </div>
    );
  }

  if (!state.any) return null;

  return (
    <div
      className="border-b px-5 py-2.5"
      style={{
        borderColor: 'var(--border-strong)',
        background: 'var(--surface-inset)',
      }}
      data-deferral="active"
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[12px] font-medium" style={{ color: 'var(--state-review)' }}>
          {state.items.length} integration{state.items.length === 1 ? '' : 's'} deferred
        </span>

        <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {state.items
            .map((i) => `${i.label ?? i.stepTitle} — "${i.reason}"`)
            .join(' · ')}
        </span>

        <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          The app is open because you deferred {state.items.length === 1 ? 'this' : 'these'},
          not because {state.items.length === 1 ? 'it is' : 'they are'} done. Anything that
          needs {state.items.length === 1 ? 'it' : 'them'} still refuses.
        </span>

        <Link
          href="/onboarding"
          className="ml-auto text-[12px] underline underline-offset-2"
          style={{ color: 'var(--text-secondary)' }}
        >
          Finish setup
        </Link>
      </div>
    </div>
  );
}
