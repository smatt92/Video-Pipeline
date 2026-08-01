import { createHash } from 'node:crypto';

import type { DraftedScript } from './schema';

/**
 * `scripts.structure_hash` — the anti-template guard.
 *
 * SCHEMA.sql calls it "hash of the beat *structure*, not the words", and ARCHITECTURE.md
 * §0.2 gives it a job: hard-block publish when the last N videos share a beat structure.
 * That exists because YouTube's inauthentic-content policy names "templated scripts with
 * minor substitutions" as the disqualifying pattern, and substituting the words is exactly
 * what a naive version of this pipeline would do while leaving the skeleton untouched.
 *
 * ── What is hashed, and what deliberately is not ─────────────────────────────
 *
 * Hashed: the number of beats, whether there is a CTA, and the pacing profile — each
 * beat's start quantised to a twentieth of the runtime.
 *
 * Not hashed: every word. Not the hook, not the beat text, and not the `intent` strings.
 * The first two are the point — a hash that changes when the words change is a hash that
 * says "unique" about the same video made twelve times, which is precisely the claim the
 * policy disbelieves.
 *
 * `intent` is excluded for a different and less satisfying reason: it is model-authored
 * free text, so "build tension" and "building tension" are the same structure and
 * different strings. Including it would make near-identical skeletons hash differently and
 * quietly turn the guard off. Excluding it costs real discrimination — two scripts with
 * the same pacing but genuinely different arguments collide — and that trade is made
 * knowingly, in this direction, because a guard that over-flags gets looked at and a guard
 * that under-flags does not.
 *
 * ── What a collision means ───────────────────────────────────────────────────
 *
 * "These two videos are built the same way." It does not mean plagiarism and it is not on
 * its own a reason to refuse to publish. The publish gate decides that, over a window and
 * a threshold that live outside this function, because the right N is an editorial
 * judgement and this is arithmetic.
 */

export const STRUCTURE_HASH_VERSION = 1;

/** Twentieths of the runtime. Fine enough to separate a front-loaded piece from an evenly
 *  paced one; coarse enough that a beat landing half a second later is the same shape. */
const QUANTA = 20;

export function structureHash(script: DraftedScript): string {
  const starts = script.beats.map((b) => b.t);
  const span = Math.max(...starts, 1);

  const profile = starts.map((t) => Math.round((t / span) * QUANTA));

  const shape = [
    `v${STRUCTURE_HASH_VERSION}`,
    `beats=${script.beats.length}`,
    `cta=${script.cta ? 1 : 0}`,
    `profile=${profile.join(',')}`,
  ].join('|');

  // Version-prefixed so a future change to what counts as structure cannot silently
  // compare against hashes computed under the old definition. Old rows keep their old
  // hashes and simply stop colliding with new ones, which is the correct behaviour —
  // the alternative is a guard that reports agreement between two things it measured
  // differently.
  return createHash('sha256').update(shape).digest('hex');
}

/** The pre-image, for the review UI. A hash nobody can explain is a hash nobody trusts. */
export function structureDescription(script: DraftedScript): string {
  return `${script.beats.length} beats${script.cta ? ' + CTA' : ', no CTA'}`;
}
