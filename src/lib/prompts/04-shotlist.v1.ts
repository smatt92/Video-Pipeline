/**
 * Stage 4 — shotlist authoring. Version 1.
 *
 * Versioned in the filename, like `03-script.v1.ts`, and for the same reason: a shot's
 * provenance is only useful if it can be traced to the instructions that produced it. Add
 * `04-shotlist.v2.ts` beside this when it changes materially; leave this one alone.
 *
 * ── What this stage does and does not decide ─────────────────────────────────
 *
 * It writes a shotlist: how many shots, what each one shows, and which stretch of the
 * voiceover each is on screen for. It does **not** write driver parameters. Those come from
 * the prompt library, which is populated from real MCP experiments — CLAUDE.md is explicit
 * that production reads the library and never improvises, because a model prompt that has
 * never produced a watchable clip is a guess that costs credits to disprove.
 *
 * So the model here is asked for editorial intent, not for vendor syntax. It never sees a
 * motion name, an aspect ratio or a model id, and it cannot invent one.
 *
 * ── The character ranges are the load-bearing part ───────────────────────────
 *
 * Each shot claims a half-open range of `vo_text`. That range is what lets stage 6 turn
 * word timings into a real duration (migration 0009), which is the whole point of the
 * audio-first inversion: VO costs about a hundredth of video generation, so the cheap
 * artifact should define the timeline the expensive one satisfies.
 *
 * Getting a model to emit exact character offsets is unreliable, so it is not asked to.
 * It returns the *text* each shot covers, verbatim, and the offsets are resolved by
 * searching for that text in `vo_text`. A quote that cannot be found is a validation
 * failure rather than a silently wrong timeline.
 */

import { shotKindMenu } from '../shots/kinds';

export const PROMPT_ID = '04-shotlist';
export const PROMPT_VERSION = 1;
export const PROMPT_REF = `${PROMPT_ID}.v${PROMPT_VERSION}`;

export interface ShotlistPromptInput {
  channel: { name: string; platform: string; niche: string };
  title: string;
  angle: string;
  hook: string;
  beats: { t: number; text: string; intent: string }[];
  cta: string | null;
  voText: string;
  /** Estimated, from the script. Real durations arrive in stage 6. */
  targetSeconds: number;
}

export const SYSTEM_PROMPT = `You are breaking a finished short-form video script into shots.

WHAT A SHOT IS
One continuous camera take. It changes when the *image* should change, which is not the
same as when the argument changes — one spoken point often wants two or three shots, and
occasionally two points share one. Decide from what is being said.

WHAT YOU RETURN
For each shot, in order:

- kind: which of the shot kinds below this frame is. Pick from the list; it is closed.
  This is what a generation recipe gets selected on, so it has to describe the frame you
  actually wrote, not the one you would prefer to have written.
- covers: the exact stretch of the voiceover spoken over this shot, copied VERBATIM from
  the vo_text you were given. Character for character, including punctuation. The shots'
  covers strings, concatenated in order, must reconstruct the whole vo_text with nothing
  missing, nothing repeated, and nothing added. This is checked.
- description: what is on screen, in plain language. Written for a person, not for a
  model — someone should be able to read it and picture the frame. Say what is in shot,
  what it is doing, and how it is framed.
- intent: why this shot rather than another. One short phrase.

HOW MANY
Between 2 and 8. A 30-second video with one shot is a slideshow; one with twelve is a
seizure. Most land between 4 and 6, but let the script decide rather than the average.

WHAT YOU ARE NOT DECIDING
Nothing about how the video gets generated. No model names, no motion names, no aspect
ratios, no camera-move jargon, no seeds, no negative prompts, no style tokens. Those come
from a library of recipes that have actually been tested, and a plausible-sounding
parameter you invented would cost real money to discover was wrong. Describe the shot;
something downstream translates it.

SHOT KINDS
{{SHOT_KINDS}}

Do not use every kind, and do not cycle through them for the sake of it. Pick the one that
fits each frame. If two videos in a row would produce the same sequence of kinds, the
problem is the shots, not the vocabulary.

VISUAL VARIETY
Consecutive shots should differ in more than their subject. If every shot is a
medium-close on a talking subject, the video is a slideshow with a voiceover. Vary the
distance, the angle, and whether anything is moving. Say so explicitly in the description.

WHAT NOT TO WRITE
No text overlays or on-screen captions — those are added at assembly and describing them
here duplicates a decision made elsewhere. No shot that depends on a specific real person,
logo or trademark. No "cut to", "we see", "camera pans" phrasing in the description; write
the frame, not the edit instruction.`.replace('{{SHOT_KINDS}}', shotKindMenu());

export function buildUserMessage(input: ShotlistPromptInput): string {
  const beats = input.beats
    .map((b, i) => `  ${i}. [${b.t}s] ${b.text}\n     (intent: ${b.intent})`)
    .join('\n');

  return [
    `Channel: ${input.channel.name} · ${input.channel.platform} · ${input.channel.niche}`,
    `Concept: ${input.title}`,
    `Angle: ${input.angle}`,
    '',
    `Target runtime: about ${input.targetSeconds} seconds.`,
    '',
    'SCRIPT',
    `Hook: ${input.hook}`,
    'Beats:',
    beats,
    input.cta ? `CTA: ${input.cta}` : 'CTA: none',
    '',
    'VO_TEXT — copy your `covers` strings verbatim out of exactly this:',
    '---',
    input.voText,
    '---',
    '',
    'Break it into shots. The covers strings must reconstruct the vo_text above exactly,',
    'in order, with no gaps and no overlaps.',
  ].join('\n');
}
