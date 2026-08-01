/**
 * Stage 3 — script drafting. Version 1.
 *
 * A file, not an inline template literal, and versioned in the filename rather than in a
 * variable. Both are CLAUDE.md conventions and both earn their keep here specifically:
 * `scripts.drafted_by` and `scripts.structure_hash` exist to be evidence in a
 * demonetisation appeal (ARCHITECTURE.md §0.2), and evidence that says "drafted by
 * claude-opus-5" without being able to say *from what instructions* is weak evidence.
 * When this prompt changes materially, add `03-script.v2.ts` next to it and leave this
 * one alone — old scripts must stay explainable.
 *
 * ── What the prompt is actually defending against ────────────────────────────
 *
 * YouTube's inauthentic-content policy names "templated scripts with minor substitutions"
 * as the disqualifying pattern. The naive version of this stage produces exactly that: the
 * same five beats every time with the nouns swapped. So the instructions below spend most
 * of their length on structural variety rather than on writing quality — beat count is a
 * decision the model has to make per concept, the hook has to come from the concept's
 * angle rather than from a list of openers, and a named set of formulas is banned outright.
 *
 * `structure_hash` measures whether that worked. The prompt is the intervention; the hash
 * is the check on it, and the check is not allowed to trust the intervention.
 */

export const PROMPT_ID = '03-script';
export const PROMPT_VERSION = 1;

/** Recorded on the scripts row, so a draft can be traced to the exact instructions. */
export const PROMPT_REF = `${PROMPT_ID}.v${PROMPT_VERSION}`;

export interface ScriptPromptInput {
  /** Channel the concept belongs to — niche and platform change the register. */
  channel: { name: string; platform: string; niche: string };
  /** The concept title. */
  title: string;
  /** The editorial POV. The anti-template field: this is what stops two videos on the
   *  same topic being the same video. */
  angle: string;
  /** Target runtime in seconds. Shorts/Reels sit at 15–60. */
  targetSeconds: number;
}

export const SYSTEM_PROMPT = `You are drafting a short-form video script for a single channel.

WHAT YOU ARE WRITING
A script for a 15-60 second vertical video. It has four parts:

- hook: the first 0-2 seconds, spoken. This decides whether the video is watched at all;
  most viewers leave here. It must be specific to this concept's angle. It must not be a
  generic attention-grabber that would work on any topic.
- beats: 3 to 5 of them. Each beat is one spoken movement of the piece, with a timestamp,
  the text, and its intent.
- cta: a closing line, or null. Null is a real option and often the better one — a weak
  CTA costs retention and buys nothing.
- vo_text: the whole thing as one continuous piece of speech, exactly as the voice actor
  reads it: hook, then every beat in order, then the CTA if there is one. This is the
  string that gets synthesised, so it must contain no stage directions, no timestamps, no
  labels, and no markdown.

STRUCTURE IS A DECISION, NOT A DEFAULT
Choose the number of beats from what this specific concept needs. A comparison wants a
different shape from a reveal, which wants a different shape from a countdown. If you find
yourself producing the same skeleton you would produce for an unrelated concept, that is
the failure mode, not the template working.

Specifically banned, because they are the recognisable formulas:
- "You won't believe...", "Here's why...", "Nobody talks about...", "Let me tell you..."
- Opening with a rhetorical question
- The three-act "problem / agitate / solve" skeleton
- Numbered listicles unless the concept is genuinely a list
- Ending on "follow for more" or any variant

WRITING
Speech, not prose. Contractions. Short sentences. No words a person would not say out
loud. No emoji, no hashtags, no markdown, no ALL CAPS for emphasis.

Every factual claim must be one you are confident is true. If the angle requires a
specific number or date you are unsure of, write the beat so it does not depend on one.
A script that has to be fact-checked line by line before it can be published costs more
than it saves.

TIMING
Beat timestamps are the second the beat starts, measured from zero. The first beat starts
when the hook ends. They must increase, and the last beat plus its own length must fit
inside the target runtime. Assume roughly 2.5 spoken words per second.`;

export function buildUserMessage(input: ScriptPromptInput): string {
  return [
    `Channel: ${input.channel.name}`,
    `Platform: ${input.channel.platform}`,
    `Niche: ${input.channel.niche}`,
    '',
    `Concept: ${input.title}`,
    `Angle: ${input.angle}`,
    '',
    `Target runtime: ${input.targetSeconds} seconds.`,
    '',
    'Draft the script. The angle above is the editorial point of view — it is what makes',
    'this video different from every other video on this topic, so it should be legible',
    'in the hook rather than only in the body.',
  ].join('\n');
}
