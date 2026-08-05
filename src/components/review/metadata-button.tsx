'use client';

import { useState, useTransition } from 'react';

import { requestMetadata } from '@/lib/review/actions';
import type { MetadataPrior } from '@/lib/metadata/prior';

/**
 * Draft the publishing metadata for a passed render.
 *
 * ── Where this lives, and why not anywhere else ──────────────────────────────
 *
 * On the review detail screen, under the decision bar. That is the only screen in the
 * product that renders a render, and metadata acts on a render — the placement rule is that
 * the control goes where the thing it acts on is drawn, not on a toolbar or a floating
 * control that would have to name its subject.
 *
 * `requestMetadata` had no caller at all until this existed, while `09-metadata.ts` carried a
 * header paragraph claiming it did. See CLAUDE.md on a caller that is itself uncalled.
 *
 * ── It appears only after a pass, because the task refuses otherwise ─────────
 *
 * Stage 9 will not draft metadata for a render that has not passed review — the DB gate is
 * the point of the whole stage. A button that is always visible is therefore a button that
 * usually errors, and an error you could have predicted from the screen's own state is worse
 * than an absent control. So the parent renders this only on a pass.
 *
 * ── The cost shown is the last one, not this one ─────────────────────────────
 *
 * Deliberate, and the label says which. There is no honest pre-flight figure for a Messages
 * call — see `src/lib/metadata/prior.ts` — so quoting one would be a fabricated measurement
 * on a button. The last charged draft is a real number and answers what the operator is
 * actually asking.
 */

export function MetadataButton({ renderId, prior }: { renderId: string; prior: MetadataPrior }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const cost =
    prior.lastCostInr === null
      ? 'not previously measured'
      : `last one cost ₹${prior.lastCostInr.toFixed(2)}`;

  return (
    <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <button
        type="button"
        disabled={pending || prior.refusal !== null}
        onClick={() =>
          start(async () => {
            const outcome = await requestMetadata(renderId);
            setResult(
              outcome.enqueued
                ? `Drafting. Run ${outcome.runId?.slice(0, 12)} — the cost row lands when the call returns.`
                : `Could not start: ${outcome.detail}`,
            );
          })
        }
        className="rounded-sm border px-3 py-[7px] text-sm disabled:opacity-40"
        style={{ borderColor: 'var(--border-strong)' }}
      >
        {/* Names the consequence, not the verb: what it produces, that it costs money, and
            what money looked like the last time. "Request metadata" said none of the three. */}
        Draft title and description — new charge, {cost}
      </button>

      {prior.refusal !== null && (
        <p className="mt-2 text-2xs" style={{ color: 'var(--state-blocked)' }}>
          {prior.refusal}
        </p>
      )}

      {result !== null && (
        <p className="mt-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
          {result}
        </p>
      )}

      {/* Split so the figure lands before the explanation — the number is what is being
          looked for, and a sentence of reasoning in front of it buries the thing the
          operator opened the screen to see. */}
      {prior.lastAt === null ? (
        <p className="mt-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
          No metadata draft has ever been charged on this workspace, so there is no prior to
          show — that is unknown, not free.
        </p>
      ) : (
        <>
          <p className="mt-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
            Last drafted {prior.lastAt.slice(0, 10)}
            {prior.lastCostInr === null ? '.' : `, cost ₹${prior.lastCostInr.toFixed(2)}.`}
          </p>
          <p className="text-2xs" style={{ color: 'var(--text-faint)' }}>
            This is what the last draft cost, not a forecast — an LLM call is priced on
            tokens that don&rsquo;t exist until it returns.
          </p>
        </>
      )}
    </div>
  );
}
