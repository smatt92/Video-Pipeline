'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { SetupProgress } from '@/lib/onboarding/progress';
import { STEPS } from '@/lib/onboarding/steps';

/**
 * The setup checklist. Collapsible, in the sidebar, and not a floating button.
 *
 * ── Why not a FAB ────────────────────────────────────────────────────────────
 *
 * A floating action button is a mobile Material pattern for the one primary action of a
 * screen. Resuming setup is neither: it is secondary, it is resumable, and it is the same
 * offer on every screen rather than a property of any one of them. A FAB would also float
 * over the pipeline canvas and the review player — the two surfaces whose whole job is to
 * show you something without anything on top of it.
 *
 * So: here, in the sidebar, with a progress badge; plus a command palette entry. All three
 * reachable by keyboard, none of them over the canvas.
 *
 * ── It hides itself when finished ────────────────────────────────────────────
 *
 * A checklist showing 8 of 8 is furniture. It disappears, and the palette entry remains for
 * anyone who wants to revisit a step.
 */
export function SetupChecklist({ progress }: { progress: SetupProgress }) {
  const [open, setOpen] = useState(false);

  if (progress.finished) return null;

  const done = progress.completed.length;

  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-sm px-2 text-xs"
        style={{ color: 'var(--text-secondary)', minHeight: 'var(--hit-min)' }}
      >
        <span aria-hidden style={{ color: 'var(--text-faint)' }}>
          {open ? '▾' : '▸'}
        </span>
        <span>Finish setup</span>
        <span
          className="ml-auto rounded-full px-2 font-mono text-3xs"
          style={{ background: 'var(--surface-3)', color: 'var(--text-muted)' }}
        >
          {done}/{progress.total}
        </span>
      </button>

      {open && (
        <ul className="mt-1 flex flex-col">
          {STEPS.map((step) => {
            const isDone = progress.completed.includes(step.n);
            const isDeferred = progress.deferred.includes(step.n);
            return (
              <li key={step.n}>
                <Link
                  href={`/setup/${step.n}`}
                  className="flex items-center gap-2 rounded-sm px-2 text-2xs"
                  style={{
                    minHeight: 'var(--hit-min)',
                    color: isDone ? 'var(--text-faint)' : 'var(--text-secondary)',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      color: isDone
                        ? 'var(--state-live)'
                        : isDeferred
                          ? 'var(--state-review)'
                          : 'var(--text-faint)',
                    }}
                  >
                    {isDone ? '●' : isDeferred ? '◐' : '○'}
                  </span>
                  <span className="truncate">{step.title}</span>
                  {/* Deferred is shown distinctly from done, because it is not done. The
                      integration it configures is still unusable and every task still
                      refuses it — collapsing the two here would be the one place in the
                      product that implies otherwise. */}
                  {isDeferred && (
                    <span className="ml-auto font-mono text-3xs" style={{ color: 'var(--state-review)' }}>
                      skipped
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
