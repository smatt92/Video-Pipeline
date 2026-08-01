import { z } from 'zod';

/**
 * The shape a drafted script must arrive in.
 *
 * This schema does two jobs and it is worth being clear that they are different. It is
 * handed to the model as the output contract, so the response is constrained to it at
 * generation time; and it validates the response after it arrives. The second is not
 * redundant. A constrained decode guarantees well-formed JSON matching the JSON Schema —
 * it does not guarantee the semantic rules below (monotonic timestamps, vo_text actually
 * containing the hook), and it does not cover the failure modes where the model stops
 * early or refuses.
 *
 * Nothing here is cast. `as` on a parsed external payload is banned by CLAUDE.md, and the
 * reason is exactly this stage: the parse either produces a value that satisfies every
 * rule below or it produces an error that becomes a row.
 */

export const BeatSchema = z.object({
  t: z
    .number()
    .min(0)
    .describe('Second this beat starts, measured from zero.'),
  text: z
    .string()
    .min(1)
    .describe('What is spoken. No stage directions, no labels.'),
  intent: z
    .string()
    .min(1)
    .describe('What this beat is doing for the piece, in a few words. Not spoken.'),
});

/**
 * The model-facing schema. Deliberately structural only — every constraint here is one a
 * constrained decode can actually honour. Cross-field rules live in the refinements below,
 * where a violation becomes a validation failure rather than a confusing generation.
 */
export const DraftedScriptSchema = z.object({
  hook: z
    .string()
    .min(1)
    .describe('Spoken, 0-2 seconds. Specific to this concept angle.'),
  beats: z.array(BeatSchema).min(3).max(5),
  cta: z
    .string()
    .min(1)
    .nullable()
    .describe('Closing line, or null. Null is a real choice, not a fallback.'),
  vo_text: z
    .string()
    .min(1)
    .describe('Hook, beats and CTA as one continuous piece of speech.'),
});

export type DraftedScript = z.infer<typeof DraftedScriptSchema>;

/** Rough spoken rate, used only to sanity-check timings. */
const WORDS_PER_SECOND = 2.5;

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Normalise for comparison: the model may punctuate `vo_text` differently from the beat it
 * came from, and it should be allowed to. What must survive is the words.
 */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The full contract, including the rules a decode constraint cannot express.
 *
 * `vo_text` is checked against the parts rather than trusted, because it is the string
 * that actually gets synthesised and paid for. A `vo_text` that has quietly dropped a beat
 * produces a video whose audio does not match its own script row — which surfaces as a
 * timing bug in the assembler two stages later, long after the cause.
 */
export const ValidatedScriptSchema = DraftedScriptSchema.superRefine((script, ctx) => {
  for (let i = 1; i < script.beats.length; i++) {
    if (script.beats[i].t <= script.beats[i - 1].t) {
      ctx.addIssue({
        code: 'custom',
        path: ['beats', i, 't'],
        message: `beat ${i} starts at ${script.beats[i].t}s, at or before beat ${i - 1} at ${script.beats[i - 1].t}s`,
      });
    }
  }

  const vo = normalise(script.vo_text);

  if (!vo.includes(normalise(script.hook))) {
    ctx.addIssue({
      code: 'custom',
      path: ['vo_text'],
      message: 'vo_text does not contain the hook — the synthesised audio would not open the way the script says it does',
    });
  }

  script.beats.forEach((beat, i) => {
    if (!vo.includes(normalise(beat.text))) {
      ctx.addIssue({
        code: 'custom',
        path: ['vo_text'],
        message: `vo_text is missing beat ${i} — the audio and the script row would disagree`,
      });
    }
  });

  if (script.cta && !vo.includes(normalise(script.cta))) {
    ctx.addIssue({ code: 'custom', path: ['vo_text'], message: 'vo_text does not contain the cta' });
  }

  // Stage directions leak in as bracketed asides and speaker labels. They are cheap to
  // spot here and expensive later: the voice reads them aloud.
  if (/\[[^\]]+\]|\([^)]*\b(?:pause|beat|cut|music|sfx|vo|voiceover)\b[^)]*\)/i.test(script.vo_text)) {
    ctx.addIssue({
      code: 'custom',
      path: ['vo_text'],
      message: 'vo_text contains what looks like a stage direction — it would be spoken aloud',
    });
  }
});

/**
 * Estimated spoken length. Not a validation rule: the real duration comes from the
 * voice driver's word timings in stage 6, and shot durations are derived from those
 * rather than from this (Addendum 02 — audio first). This is only for the warning that
 * the draft is obviously the wrong length before anything is synthesised.
 */
export function estimatedSeconds(script: DraftedScript): number {
  const spoken = [script.hook, ...script.beats.map((b) => b.text), script.cta ?? ''].join(' ');
  return words(spoken) / WORDS_PER_SECOND;
}
