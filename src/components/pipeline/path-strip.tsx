import { Hint } from '@/components/shell/hint';
import { PATH, type PathPosition, type StageState } from '@/lib/pipeline/path';

/**
 * The path, per concept.
 *
 * One row, left to right, in the order the stages actually run. The board answers "is
 * everything okay?" across concepts; this answers "where am I?" for one — which the app has
 * never told anybody, because it assumed you already knew.
 *
 * Two decisions, both load-bearing:
 *
 *   · **Voice is drawn before Videos**, which reads backwards and is correct. Sorting by
 *     stage number would put 05 before 06 and teach the mistake the whole audio-first
 *     inversion exists to prevent. `whyHere` sits on the stage rather than in a footnote,
 *     because the moment somebody wonders is the moment they are pointing at it.
 *
 *   · **"Waiting on you" is not "blocked".** A pilot awaiting approval has nothing wrong
 *     with it, and rendering it as a problem sends a person hunting a misconfiguration that
 *     does not exist. `v_pipeline_blockers` has twice reported an invented state as
 *     something it was not; a pending pilot shown as stalled would be the third.
 */

const STATE_STYLE: Record<StageState, { dot: string; text: string }> = {
  done: { dot: 'var(--state-live)', text: 'var(--text-muted)' },
  current: { dot: 'var(--accent)', text: 'var(--text-primary)' },
  blocked: { dot: 'var(--state-blocked)', text: 'var(--text-primary)' },
  waiting_on_you: { dot: 'var(--state-review)', text: 'var(--text-primary)' },
  ahead: { dot: 'var(--border-strong)', text: 'var(--text-faint)' },
};

export function PathStrip({ position }: { position: PathPosition }) {
  const current = PATH.find((p) => p.key === position.currentKey);

  return (
    <div
      className="rounded-md border px-4 py-3"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
    >
      <div className="mb-2 flex items-baseline gap-3">
        <span className="truncate text-sm">{position.title}</span>
        <span className="text-2xs" style={{ color: 'var(--text-faint)' }}>
          {position.awaitingPilotApproval
            ? 'waiting on you'
            : position.blocker
              ? 'blocked'
              : `at ${current?.label.toLowerCase()}`}
        </span>
      </div>

      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {PATH.map((stage, i) => {
          const state = position.stages[i]?.state ?? 'ahead';
          const style = STATE_STYLE[state];
          return (
            <li key={stage.key} className="flex items-center gap-1">
              <Hint
                content={
                  stage.whyHere ? `${stage.what} — ${stage.whyHere}` : `${stage.what} (${stage.stage})`
                }
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block rounded-full"
                    style={{ width: 7, height: 7, background: style.dot }}
                  />
                  <span
                    className="text-2xs"
                    style={{
                      color: style.text,
                      // The counterintuitive step is marked in the path itself rather than
                      // in prose nobody reads: voice before videos is the thing to notice.
                      borderBottom: stage.whyHere ? '1px dotted var(--border-strong)' : undefined,
                    }}
                  >
                    {stage.label}
                  </span>
                </span>
              </Hint>
              {i < PATH.length - 1 && (
                <span className="mx-0.5 text-2xs" style={{ color: 'var(--border-strong)' }}>
                  ›
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {(position.blocker || position.awaitingPilotApproval) && (
        <p
          className="mt-2 text-2xs"
          style={{
            color: position.awaitingPilotApproval ? 'var(--state-review)' : 'var(--state-blocked)',
          }}
        >
          {position.blocker}
        </p>
      )}
    </div>
  );
}
