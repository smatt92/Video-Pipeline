import { z } from 'zod';

/**
 * What stage 2 is allowed to come back with.
 *
 * Two schemas, for the same reason stage 3 has two: a decode constraint can enforce shape
 * and range, and it cannot enforce a relationship between fields. `ProposedConceptsSchema`
 * is what the model is decoded against; the refinements below run afterwards, where a
 * violation is a legible validation error rather than a generation that quietly cannot
 * terminate.
 *
 * ── The axes are all "higher is better", and that is load-bearing ────────────
 *
 * `saturation` here means *room left*, not *how saturated*. The prompt says so at length
 * because it is the one field a reader will assume they understand. Keeping every axis
 * pointing the same way is what makes `score_total` a plain mean — the alternative is a
 * subtraction somewhere, and a subtraction somewhere is an inverted ranking the first time
 * anyone refactors it.
 *
 * ── ip_risk is not an axis ───────────────────────────────────────────────────
 *
 * It is an enum, it lives in its own column, and it is deliberately absent from the mean.
 * A concept that needs copyrighted footage is not a good concept with a caveat; it is one
 * a human has to decide about, and averaging it in would let velocity outvote a legal
 * problem.
 */

export const ipRisk = z.enum(['low', 'medium', 'high']);

const axis = z.number().min(0).max(1);

export const ProposedConceptSchema = z.object({
  title: z.string().min(8).max(120),
  /** The anti-template field. See the prompt for why a topic is not an angle. */
  angle: z.string().min(12).max(400),
  scores: z.object({
    velocity: axis,
    /** How much room is LEFT. Inverted from the ordinary meaning — see above. */
    saturation: axis,
    evergreen: axis,
    execution: axis,
  }),
  ip_risk: ipRisk,
  /** One sentence naming the single strongest reason, not a summary of the axes. */
  rationale: z.string().min(12).max(400),
  /** Which trend terms this came from. Empty when the model worked from the niche. */
  from_signals: z.array(z.string()).default([]),
});

export const ProposedConceptsSchema = z.object({
  concepts: z.array(ProposedConceptSchema).min(1).max(10),
});

export type ProposedConcept = z.infer<typeof ProposedConceptSchema>;

/**
 * The mean of the four axes. IP risk is not in it — see the note above.
 *
 * Rounded to three places because it is stored in `numeric` and compared for ordering; an
 * unrounded float makes two identical concepts sort unstably, which reads as the ranking
 * being random.
 */
export function scoreTotal(scores: ProposedConcept['scores']): number {
  const { velocity, saturation, evergreen, execution } = scores;
  return Math.round(((velocity + saturation + evergreen + execution) / 4) * 1000) / 1000;
}

/**
 * The relationships a decode constraint cannot express.
 *
 * Returns the concepts that survive, and why each rejection happened. Rejections are data
 * rather than exceptions: one bad concept out of five must not throw away the other four,
 * and the model has already been paid for all five.
 */
export function validateConcepts(proposed: readonly ProposedConcept[]): {
  kept: ProposedConcept[];
  rejected: { title: string; reason: string }[];
} {
  const kept: ProposedConcept[] = [];
  const rejected: { title: string; reason: string }[] = [];
  const seenAngles = new Set<string>();

  for (const c of proposed) {
    // The prompt forbids two concepts sharing an angle, and the whole anti-template
    // argument rests on it, so it is checked rather than trusted. Normalised on words
    // rather than on the raw string: "the concrete is the story" and "The concrete is the
    // story." are the same angle and a model will produce both.
    const key = c.angle.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).sort().join(' ');
    if (seenAngles.has(key)) {
      rejected.push({ title: c.title, reason: 'duplicate angle within this batch' });
      continue;
    }

    // An angle that restates the title is not an angle. This is the failure mode the prompt
    // is most likely to fall into on a weak trend, and it is invisible until stage 3
    // produces a generic script from it.
    //
    // Measured as *how much of the title the angle reuses*, not the reverse. The first
    // version divided by the angle's length and let "Bridges collapse in winter because of
    // ice" through against the title "Why bridges collapse in winter" — the angle reused
    // every content word in the title and scored 0.43, because it was longer. Length is not
    // originality; a restatement with three extra words is still a restatement.
    const content = (t: string) =>
      t
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 3);

    const titleWords = content(c.title);
    const angleWords = new Set(content(c.angle));
    const reused = titleWords.filter((w) => angleWords.has(w)).length;

    // Two content words minimum before the rule applies. A one-word title whose noun the
    // angle mentions is normal, and rejecting it would refuse a good concept for naming
    // its own subject.
    if (titleWords.length >= 2 && reused / titleWords.length > 0.8) {
      rejected.push({
        title: c.title,
        reason: 'the angle restates the title rather than adding a point of view',
      });
      continue;
    }

    seenAngles.add(key);
    kept.push(c);
  }

  return { kept, rejected };
}
