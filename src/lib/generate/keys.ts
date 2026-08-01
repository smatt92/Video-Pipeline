import { createHash } from 'node:crypto';

/**
 * Idempotency keys for generation submits.
 *
 * CLAUDE.md rule 6: every generation carries one, and retries must not double-charge. The
 * key is a UNIQUE column on `generations`, so a duplicate submit is refused by the
 * database rather than by a check that can be raced — which is the only version of this
 * guarantee worth having, because the race is exactly the retry scenario it defends against.
 *
 * ── What goes into it, and what deliberately does not ────────────────────────
 *
 * In: the shot, the attempt, and a hash of the exact payload being submitted. The payload
 * hash is what makes a *changed* request a *different* generation — recompiling a shot
 * against a new recipe should be a new charge, because it is a new clip.
 *
 * Out: anything that varies between retries of the same logical submit. No timestamp, no
 * run id, no random suffix. A key that changes on retry is not an idempotency key, it is a
 * unique id with extra steps, and it would let a task-level retry bill twice — which is
 * precisely what rule 6 exists to stop.
 */
export function generationKey(params: {
  shotId: string;
  /** Bumped deliberately by a human pressing regenerate, never by a retry. */
  attempt: number;
  kind: 'image' | 'video';
  payload: unknown;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(params.payload))
    .digest('hex')
    .slice(0, 16);

  return `shot:${params.shotId}:${params.kind}:a${params.attempt}:${digest}`;
}
