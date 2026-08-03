'use client';

import { useCallback, useEffect, useState } from 'react';

import type { TourStep } from '@/lib/onboarding/tour';
import { SEEN_COOKIE, seenCookieAttributes } from '@/lib/onboarding/entry';
import { Fork } from './fork';
import { TourBackdrop } from './tour-backdrop';

/**
 * The tour. The whole of it — there is no second renderer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * This is not the fallback
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Built first and deliberately: it is what `prefers-reduced-motion` users see, what anyone
 * without WebGL sees, and what everyone sees the instant a `webglcontextlost` event fires
 * mid-sequence. Between those three that is not an edge case, and a fallback written after
 * the "real" version is always a summary of it.
 *
 * An earlier draft of this comment said the 3D layer would mount *over* this and read the
 * same `steps` array — two renderers, one content array. It landed differently and better:
 * `TourBackdrop` draws *behind* this and renders no content at all. The words, the buttons,
 * the keyboard handling, the focus order and the cookie write have exactly one
 * implementation, which is this one, which is the one everybody gets. What the 3D adds is
 * arrangement — where a stage sits relative to the others, what flows into what — and it
 * cannot add a sentence because it has no way to draw one. See `src/lib/onboarding/scene.ts`
 * for how that is a property of the types rather than a rule somebody remembers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Marking it seen
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The cookie is written when the visitor reaches the fork, by any route — finishing the
 * last step or pressing Skip. Both mean "I know what this is", which is the only thing the
 * flag records. Written from the client because a round trip to a route handler to record
 * "I read this" is latency for nothing, and it is one non-identifying bit.
 *
 * Not `httpOnly` for that reason. It is read by middleware, which sees it either way.
 */

export function TourScreen({
  steps,
  signedIn,
  replay,
}: {
  steps: readonly TourStep[];
  signedIn: boolean;
  /** True when this is a deliberate re-run from the palette rather than a first visit. */
  replay: boolean;
}) {
  const [index, setIndex] = useState(0);
  const [atFork, setAtFork] = useState(false);

  const markSeen = useCallback(() => {
    document.cookie = `${SEEN_COOKIE}=1; ${seenCookieAttributes()}`;
  }, []);

  const finish = useCallback(() => {
    markSeen();
    setAtFork(true);
  }, [markSeen]);

  const next = useCallback(() => {
    setIndex((i) => {
      if (i + 1 >= steps.length) {
        finish();
        return i;
      }
      return i + 1;
    });
  }, [steps.length, finish]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (atFork) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        next();
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        back();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [atFork, next, back, finish]);

  if (atFork) return <Fork signedIn={signedIn} />;

  const step = steps[index];
  const last = index === steps.length - 1;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col px-6 py-10">
      {/* Behind everything, full-bleed, and absent unless it can run. Passed the index and
          nothing else — it has no access to the copy, which is the point. It is fixed to
          the viewport rather than to this column: the column is 760px and the thing being
          drawn is an eleven-stage track, which inside that width would be a diagram of
          nothing. */}
      <TourBackdrop index={index} />
      {/* Skip is at the top and always visible. Burying a skip control at the bottom of a
          sequence is the pattern that makes people feel trapped in it, and one-click means
          one click from anywhere — not one click once you have scrolled. */}
      <div className="flex items-baseline gap-3">
        <span
          className="font-mono text-2xs uppercase tracking-[0.09em]"
          style={{ color: 'var(--text-faint)' }}
        >
          {replay ? 'replay' : 'what this is'} · {index + 1} of {steps.length}
        </span>
        <button
          type="button"
          onClick={finish}
          className="ml-auto rounded-sm px-3 text-xs"
          style={{ color: 'var(--text-muted)', minHeight: 'var(--hit-min)' }}
        >
          Skip
        </button>
      </div>

      <div className="flex flex-1 flex-col justify-center py-10">
        <h1 className="max-w-[24ch] text-xl font-medium leading-tight tracking-tight">
          {step.title}
        </h1>
        <p
          className="mt-4 max-w-[62ch] text-md leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}
        >
          {step.body}
        </p>
      </div>

      {/* Progress as discrete marks, not a bar. Five steps is countable, and a bar implies a
          continuous quantity that nobody is measuring. */}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <button
            key={s.id}
            type="button"
            aria-label={`Step ${i + 1}: ${s.title}`}
            aria-current={i === index ? 'step' : undefined}
            onClick={() => setIndex(i)}
            className="rounded-full"
            style={{
              width: i === index ? 20 : 8,
              height: 4,
              minHeight: 4,
              padding: 0,
              background: i <= index ? 'var(--accent)' : 'var(--surface-3)',
              transitionDuration: 'var(--duration-fast)',
            }}
          />
        ))}

        <div className="ml-auto flex items-center gap-2">
          {index > 0 && (
            <button
              type="button"
              onClick={back}
              className="rounded-sm border px-4 text-sm"
              style={{ borderColor: 'var(--border-strong)', minHeight: 'var(--hit-primary)' }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={next}
            className="rounded-sm px-4 text-sm font-medium"
            style={{
              background: 'var(--accent)',
              color: 'var(--accent-contrast)',
              minHeight: 'var(--hit-primary)',
            }}
          >
            {last ? 'Done' : 'Next'}
          </button>
        </div>
      </div>

      {/* The progress marks are 4px tall, which is under the 24px target minimum. They are
          a shortcut, not the primary control — Next and Back are — so the keyboard path is
          what makes them legitimate rather than their size. Stated here because a reviewer
          measuring targets will otherwise flag them, correctly, and the answer is that they
          are redundant with a compliant control rather than that 4px is fine. */}
      <p className="mt-6 text-2xs" style={{ color: 'var(--text-faint)' }}>
        ← → to move, Esc to skip.
      </p>
    </div>
  );
}
