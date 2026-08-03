/**
 * Stage 2 — concept generation and scoring. Version 1.
 *
 * Versioned in the filename, like every other prompt here, and for the sharpest version of
 * the reason: `concepts.rubric_version` and `concepts.scores` are the record of *why* a
 * concept was approved. A score of 0.82 with no way to recover the rubric that produced it
 * is a number, not a judgement. When the rubric changes materially, add `02-concept.v2.ts`
 * and leave this alone — every concept scored under v1 must stay explainable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The rubric is four axes, and one of them is not about quality
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ARCHITECTURE.md §4 names them: velocity, saturation, IP risk, evergreen tail. Three are
 * ordinary editorial judgement. **IP risk is not** — it is the axis that decides whether
 * making the video is safe, and it is scored separately and surfaced separately because
 * averaging it into a total would let a high-velocity idea outvote a legal problem.
 *
 * So `score_total` deliberately excludes it. A concept can score 0.9 and still be
 * unusable, and the schema says so with a separate `ip_risk` column rather than a number
 * somewhere in `scores`.
 *
 * ── Saturation is scored inverted, and this is the easy mistake ──────────────
 *
 * High saturation is *bad* — it means everyone has made this video. The model is told to
 * report `saturation` as "how much room is left", so every axis points the same way and
 * the total is a plain mean. Asking for saturation directly and then subtracting is the
 * version that produces a silently inverted ranking the first time somebody refactors it.
 *
 * ── Why the model proposes an angle rather than a topic ──────────────────────
 *
 * A topic is not a concept. "Why cities are hotter" is a topic; "the concrete is the
 * story" is an angle, and the angle is the entire anti-template mechanism — two channels
 * covering the same trend produce different videos only if their angles differ. Stage 3
 * reads the angle and nothing else about the trend, so a concept with a weak angle
 * produces a generic script no amount of prompt work at stage 3 can rescue.
 */

export const PROMPT_ID = '02-concept';
export const PROMPT_VERSION = 1;

/** Recorded on the concepts row as `rubric_version`. */
export const PROMPT_REF = `${PROMPT_ID}.v${PROMPT_VERSION}`;

export interface ConceptPromptInput {
  readonly channel: { name: string; platform: string; niche: string };
  /** How many concepts to propose. */
  readonly count: number;
  /** Trend signals to work from. May be empty — see the note in the user message. */
  readonly signals: readonly {
    source: string;
    term: string;
    region: string | null;
    velocity: number | null;
    volume: number | null;
  }[];
  /** Titles already in the pipeline, so the model does not re-propose them. */
  readonly recentTitles: readonly string[];
  /** Optional operator seed, for the case where there are no signals yet. */
  readonly seed?: string;
}

export const SYSTEM_PROMPT = `You propose and score short-form video concepts for one channel.

A CONCEPT IS A TITLE PLUS AN ANGLE.
The title is what a viewer sees. The angle is the editorial point of view — the specific
claim or frame that makes this video different from every other video on the same topic.
"Why cities are hotter" is a topic. "The concrete is the story, not the sun" is an angle.
A concept without a real angle is worthless downstream: the scriptwriter reads the angle and
almost nothing else, so a vague angle produces a generic script.

NEVER propose two concepts that share an angle, even under different titles. If a trend only
supports one angle, propose one concept for it and move on.

SCORE EACH CONCEPT ON FOUR AXES, EACH 0 TO 1.

velocity      How fast interest in this is rising right now. 0 = flat or declining,
              1 = climbing steeply. Judge from the signals given; if there are none, judge
              from what you know and say so in the rationale.

saturation    HOW MUCH ROOM IS LEFT. This is deliberately inverted from the ordinary
              meaning: 1 = almost nobody has covered this angle, 0 = the market is
              saturated with it. Every axis in this rubric points the same way — higher is
              better — so do not report "how saturated" and expect it to be flipped later.

evergreen     How much of the interest survives the news cycle. 0 = worthless in a week,
              1 = as good in a year as today.

execution     How well this can be made as an AI-generated short video specifically.
              Concepts that need a named person on camera, a real location, or footage of a
              live event score low here regardless of how good the idea is.

SCORE IP RISK SEPARATELY, AND NOT ON THAT SCALE.
Report ip_risk as one of: "low", "medium", "high".
  low     original framing, no protected characters, no reused footage implied
  medium  discusses a franchise, brand or public figure without depicting them
  high    would need copyrighted characters, music, film or game footage to work at all
IP risk is NOT averaged into the total. A brilliant idea that needs Disney footage is not a
0.9 concept with an asterisk; it is a concept that cannot be made. Score it honestly and let
a human decide.

RATIONALE.
One sentence per concept, naming the single strongest reason for the score. Not a summary of
the axes — the reason. "Search interest tripled this month and nobody has covered the
supply-chain angle" is useful. "Scores well on velocity and saturation" is not.

Return ONLY valid JSON matching the schema. No prose, no code fences.`;

export function buildUserMessage(input: ConceptPromptInput): string {
  const { channel, count, signals, recentTitles, seed } = input;

  const signalBlock = signals.length
    ? signals
        .map(
          (s) =>
            `- ${s.term} (${s.source}${s.region ? `, ${s.region}` : ''})` +
            `${s.velocity !== null ? `, velocity ${s.velocity}` : ''}` +
            `${s.volume !== null ? `, volume ${s.volume}` : ''}`,
        )
        .join('\n')
    : // Not an error. Stage 1 does not exist yet, and a channel with no trend data still
      // needs concepts — from the operator's seed, or from the model's own knowledge of
      // the niche. Saying so plainly beats sending an empty list and hoping.
      '(none — no trend signals have been collected for this channel yet. Work from the ' +
      'niche and the seed below, and score velocity from what you know rather than ' +
      'guessing at a number you have no evidence for.)';

  const recentBlock = recentTitles.length
    ? recentTitles.map((t) => `- ${t}`).join('\n')
    : '(none yet)';

  return `CHANNEL
  name: ${channel.name}
  platform: ${channel.platform}
  niche: ${channel.niche}

TREND SIGNALS
${signalBlock}

ALREADY IN THE PIPELINE — do not propose these again, or minor rewordings of them
${recentBlock}
${seed ? `\nOPERATOR SEED — treat this as the strongest signal in the list\n  ${seed}\n` : ''}
Propose ${count} concepts.`;
}
