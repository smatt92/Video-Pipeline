import { CREDIT_USD, startTask, type RunwayCall, type Submitted } from './runway';

/**
 * Video and image generation on the Runway API (decision 0015).
 *
 * character_beat → `gen4_turbo` image-to-video from the character's locked reference frame.
 * money_shot     → `veo3.1_fast`, image-to-video when a start frame is given, else
 *                  text-to-video, with **audio passed explicitly false**.
 * reference frame → `gen4_image` (or `gen4_image_turbo`) text-to-image with up to three
 *                  reference images.
 *
 * Every constraint below was read from the vendor's SDK typings (sdk-node 4.21.0, main,
 * 2026-10-06) and is enforced here rather than discovered as a 400 after a job was ledgered.
 * Nothing in this file has been called against the real host from this container (0008).
 *
 * ── Durations and ratios differ per model ────────────────────────────────────
 *
 * | model        | durations             | 9:16 ratio            | image          |
 * |--------------|-----------------------|-----------------------|----------------|
 * | gen4_turbo   | integer 2–10 s (SDK v3.5.0 doc comment; 4.21.0 types it `number`) | `720:1280` only | required (first frame) |
 * | veo3.1_fast  | 4, 6 or 8 s only      | `720:1280`, `1080:1920` | optional (first / last) |
 * | gen4_image   | —                     | `720:1280`, `1080:1920` | ≤ 3 references, tag 3–16 chars |
 *
 * A shot is generated at the shortest allowed length that covers it, and **that** length is
 * what is priced: the estimator and the submit both call `clipSeconds`, so the rupee figure a
 * cap is checked against is the length the vendor bills. A 3.2 s money shot is a 4 s Veo
 * clip; a 7.4 s character beat is an 8 s gen4_turbo clip.
 *
 * ── Audio ────────────────────────────────────────────────────────────────────
 *
 * Veo's `audio` is optional in the schema and "audio inclusion affects pricing" (10 → 15
 * credits/s). We lay our own VO and bed under every shot, so audio is never wanted — and an
 * option whose default is the behaviour you are avoiding is passed, never omitted (CLAUDE.md).
 * `audio: false` is in every Veo body this file builds, and `test:bureau` asserts it.
 */

export const VIDEO_MODELS = {
  gen4_turbo: {
    path: '/image_to_video',
    creditsPerSecond: 5,
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    ratio916: '720:1280',
    imageRequired: true,
  },
  'veo3.1_fast': {
    path: '/image_to_video',
    textPath: '/text_to_video',
    /** Audio off. With audio it is 15 — never sent, see above. */
    creditsPerSecond: 10,
    durations: [4, 6, 8],
    ratio916: '720:1280',
    imageRequired: false,
  },
} as const;
export type RunwayVideoModel = keyof typeof VIDEO_MODELS;

export function isRunwayVideoModel(m: string): m is RunwayVideoModel {
  return Object.prototype.hasOwnProperty.call(VIDEO_MODELS, m);
}

/**
 * The clip length the vendor will bill for a shot of `shotSeconds`: the shortest allowed
 * duration ≥ the shot, or the longest allowed when the shot is longer than any (the
 * assembler trims or the shot is split upstream — a beat is capped at 8 s by policy).
 * Null for a model this driver does not know.
 */
export function clipSeconds(model: string, shotSeconds: number): number | null {
  if (!isRunwayVideoModel(model)) return null;
  const allowed: readonly number[] = VIDEO_MODELS[model].durations;
  return allowed.find((d) => d >= shotSeconds) ?? allowed[allowed.length - 1];
}

/** Credits one call costs for a shot, at the published per-second figure. */
export function clipCredits(model: string, shotSeconds: number): number | null {
  const s = clipSeconds(model, shotSeconds);
  return s === null || !isRunwayVideoModel(model) ? null : s * VIDEO_MODELS[model].creditsPerSecond;
}

const ASPECT_TO_RATIO: Record<string, string> = { '9:16': '720:1280' };

export type BodyResult = { ok: true; path: string; body: Record<string, unknown>; seconds: number } | { ok: false; detail: string };

/** The vendor's promptText limit: 1000 UTF-16 code units, for every model here. */
export const PROMPT_MAX = 1000;

/**
 * Build the request body for a shot. Pure — `test:bureau` drives it directly.
 *
 * Our params (from the recipe + `enqueueGeneration`): `prompt`, `negative_prompt`,
 * `duration_s`, `aspect_ratio`, `image_url` (resolved by the dispatcher from the character's
 * locked frame), `seed`.
 */
export function videoRequestBody(model: string, p: Record<string, unknown>): BodyResult {
  if (!isRunwayVideoModel(model)) return { ok: false, detail: `"${model}" is not a Runway video model this driver knows (${Object.keys(VIDEO_MODELS).join(', ')}).` };
  const spec = VIDEO_MODELS[model];
  const prompt = String(p.prompt ?? '');
  if (prompt.length === 0) return { ok: false, detail: 'empty prompt' };
  if (prompt.length > PROMPT_MAX) {
    // Refused rather than clipped: a clipped prompt silently loses whatever came last — in
    // this pipeline, the style rule — and the shot comes back off-model and billed.
    return { ok: false, detail: `prompt is ${prompt.length} characters; the vendor's limit is ${PROMPT_MAX}. Shorten the recipe template or the shot description.` };
  }
  const aspect = String(p.aspect_ratio ?? '9:16');
  const ratio = ASPECT_TO_RATIO[aspect];
  if (!ratio) return { ok: false, detail: `aspect ${aspect} has no ratio mapping; Bureau renders 9:16 only.` };
  const wanted = Number(p.duration_s);
  if (!Number.isFinite(wanted) || wanted <= 0) return { ok: false, detail: `duration_s ${String(p.duration_s)} is not a positive number` };
  const seconds = clipSeconds(model, wanted)!;
  const image = typeof p.image_url === 'string' && p.image_url.length > 0 ? p.image_url : null;
  if (spec.imageRequired && !image) {
    return { ok: false, detail: `${model} is image-to-video only and no reference frame was resolved — it would generate a different-looking character.` };
  }
  const seed = Number.isInteger(p.seed) ? { seed: p.seed } : {};

  if (model === 'gen4_turbo') {
    return {
      ok: true,
      path: spec.path,
      seconds,
      body: { model, promptImage: [{ uri: image, position: 'first' }], promptText: prompt, ratio, duration: seconds, ...seed },
    };
  }
  // veo3.1_fast
  const veo = VIDEO_MODELS['veo3.1_fast'];
  return {
    ok: true,
    path: image ? veo.path : veo.textPath,
    seconds,
    body: {
      model,
      ...(image ? { promptImage: [{ uri: image, position: 'first' }] } : {}),
      promptText: prompt,
      ratio,
      duration: seconds,
      // Explicit. See the header: the alternative costs 50% more and we discard the track.
      audio: false,
      ...(typeof p.negative_prompt === 'string' && p.negative_prompt ? { negativePrompt: p.negative_prompt } : {}),
      ...seed,
    },
  };
}

export async function submitVideo(model: string, params: Record<string, unknown>, call: RunwayCall): Promise<Submitted & { seconds?: number }> {
  const b = videoRequestBody(model, params);
  if (!b.ok) return { ok: false, code: 'invalid_input', detail: b.detail, retryAfterS: null };
  const r = await startTask(b.path, b.body, call);
  return r.ok ? { ...r, seconds: b.seconds } : r;
}

/** Act-Two, through the same client. Credits per second are carried by the recipe. */
export function submitPerformance(model: string, p: Record<string, unknown>, call: RunwayCall): Promise<Submitted> {
  return startTask(
    '/character_performance',
    {
      model,
      character: { type: 'image', uri: p.character_image_url },
      reference: { type: 'video', uri: p.reference_video_url },
      ratio: p.ratio ?? '720:1280',
      bodyControl: p.body_control ?? true,
      expressionIntensity: p.expression_intensity ?? 3,
    },
    call,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Reference frames — text-to-image with reference images
// ═════════════════════════════════════════════════════════════════════════════

export const IMAGE_MODELS = {
  /** 5 credits at 720p, 8 at 1080p (plan v2.3 figures; 0015). References optional, ≤ 3. */
  gen4_image: { credits: { '720:1280': 5, '1080:1920': 8 } as Record<string, number>, referencesRequired: false },
  /** 2 credits. References REQUIRED (SDK: `referenceImages` is not optional). */
  gen4_image_turbo: { credits: { '720:1280': 2, '1080:1920': 2 } as Record<string, number>, referencesRequired: true },
} as const;
export type RunwayImageModel = keyof typeof IMAGE_MODELS;

/** The rate_card unit for an image at a ratio — one row per price point. */
export function imageRateUnit(ratio: string): string {
  return ratio === '1080:1920' ? 'image_1080p' : 'image_720p';
}

export function imageCredits(model: RunwayImageModel, ratio: string): number | null {
  return IMAGE_MODELS[model].credits[ratio] ?? null;
}

const TAG = /^[A-Za-z][A-Za-z0-9_]{2,15}$/;

export function imageRequestBody(input: {
  model: RunwayImageModel;
  prompt: string;
  ratio: '720:1280' | '1080:1920';
  references: { uri: string; tag?: string }[];
  seed?: number;
}): { ok: true; body: Record<string, unknown> } | { ok: false; detail: string } {
  if (!input.prompt || input.prompt.length > PROMPT_MAX) return { ok: false, detail: `prompt must be 1–${PROMPT_MAX} characters (got ${input.prompt.length})` };
  if (input.references.length > 3) return { ok: false, detail: 'at most three reference images' };
  if (IMAGE_MODELS[input.model].referencesRequired && input.references.length === 0) {
    return { ok: false, detail: `${input.model} requires at least one reference image` };
  }
  const badTag = input.references.find((r) => r.tag !== undefined && !TAG.test(r.tag));
  if (badTag) return { ok: false, detail: `tag "${badTag.tag}" must be 3–16 characters, start with a letter, letters/digits/underscores only` };
  return {
    ok: true,
    body: {
      model: input.model,
      promptText: input.prompt,
      ratio: input.ratio,
      ...(input.references.length ? { referenceImages: input.references.map((r) => (r.tag ? { uri: r.uri, tag: r.tag } : { uri: r.uri })) } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    },
  };
}

export async function submitImage(input: Parameters<typeof imageRequestBody>[0], call: RunwayCall): Promise<Submitted> {
  const b = imageRequestBody(input);
  if (!b.ok) return { ok: false, code: 'invalid_input', detail: b.detail, retryAfterS: null };
  return startTask('/text_to_image', b.body, call);
}

/** USD for a number of credits, at the published price. */
export const creditsToUsd = (credits: number) => credits * CREDIT_USD;
