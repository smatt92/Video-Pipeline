import { z } from 'zod';

/**
 * Which TTS vendor speaks a character, and with which voice.
 *
 * Lives in the driver layer because the shape names vendors: `characters.json` says
 * `voice: { provider: "runway", preset_id }` plus an optional `elevenlabs_voice_id` for the
 * per-character upgrade path (plan v2.2, Prompt H). The bible loader imports this schema
 * rather than spelling the keys itself, so rule 1 holds without renaming the JSON's fields
 * to something vague — decision 0012 row 6 is superseded by 0013.
 *
 * ── One predicate, shared ────────────────────────────────────────────────────
 *
 * `voiceRouteFor` is the only place that decides "which driver, which id, or why not".
 * The voice stage, the audition script and the blocker read all call it. Two stages that
 * each decided this for themselves is how 0008 found two guards drifting into the same
 * wrong shape independently.
 */

/** Runway's preset ids for the eleven_v3 / eleven_multilingual_v2 TTS models. Read from
 *  the vendor's published OpenAPI typings (sdk-node, `text-to-speech.ts`) on 2026-10-06. */
export const TTS_PRESET_IDS = [
  'Maya', 'Arjun', 'Serene', 'Bernard', 'Billy', 'Mark', 'Clint', 'Mabel', 'Chad', 'Leslie',
  'Eleanor', 'Elias', 'Elliot', 'Grungle', 'Brodie', 'Sandra', 'Kirk', 'Kylie', 'Lara', 'Lisa',
  'Malachi', 'Marlene', 'Martin', 'Miriam', 'Monster', 'Paula', 'Pip', 'Rusty', 'Ragnar', 'Xylar',
  'Maggie', 'Jack', 'Katie', 'Noah', 'James', 'Rina', 'Ella', 'Mariah', 'Frank', 'Claudia',
  'Niki', 'Vincent', 'Kendrick', 'Myrna', 'Tom', 'Wanda', 'Benjamin', 'Kiana', 'Rachel',
] as const;

export const VOICE_PROVIDERS = ['runway', 'elevenlabs'] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const CharacterVoiceSchema = z.object({
  provider: z.enum(VOICE_PROVIDERS),
  /** Null until `voice:lock` writes Sahil's audition pick. */
  preset_id: z.enum(TTS_PRESET_IDS).nullable(),
});
export type CharacterVoice = z.infer<typeof CharacterVoiceSchema>;

/** The two fields a character carries in the bible, parsed together. */
export const CharacterVoiceFields = {
  voice: CharacterVoiceSchema,
  /** Optional. Only read when `voice.provider` is the direct vendor. */
  elevenlabs_voice_id: z.string().min(1).nullable().optional(),
};

export type VoiceRoute =
  | { ok: true; provider: VoiceProvider; voiceId: string; integration: string; model: string }
  | { ok: false; code: 'voice_not_locked' | 'direct_voice_missing'; detail: string };

/** The default TTS model. eleven_v3 is expressive and carries audio tags (Prompt H). */
export const DEFAULT_TTS_MODEL = 'eleven_v3';

/**
 * The second model, for voice overflow (O5, channel_policy.voice_overflow). On the same vendor
 * and the same presets, with its OWN daily limit (50/day, separate from v3's 50/day) — so when
 * v3 is limited, the whole episode can be re-voiced here instead of waiting. Slightly less
 * expressive: it reads no audio tags and takes no seed or language code.
 */
export const OVERFLOW_TTS_MODEL = 'eleven_multilingual_v2';

export const TTS_MODELS = [DEFAULT_TTS_MODEL, OVERFLOW_TTS_MODEL] as const;
export type TtsModelName = (typeof TTS_MODELS)[number];

export function isTtsModel(m: string): m is TtsModelName {
  return (TTS_MODELS as readonly string[]).includes(m);
}

/** A person-readable name for a model, for Cuts and Settings — never the vendor's id alone. */
export const TTS_MODEL_LABEL: Record<TtsModelName, string> = {
  [DEFAULT_TTS_MODEL]: 'the main voice model',
  [OVERFLOW_TTS_MODEL]: 'the second voice model',
};

/** The same route on another model — the whole-episode overflow re-routes every speaker with this. */
export function withModel(route: Extract<VoiceRoute, { ok: true }>, model: TtsModelName): Extract<VoiceRoute, { ok: true }> {
  return { ...route, model };
}

/**
 * A voice chosen on the Voices screen (`channel_voice_overrides`), which wins over the bible.
 * `provider` is a string from the database, so it is checked here, where the vendor names live.
 */
export interface VoiceOverride {
  readonly provider: string;
  readonly voiceId: string;
}

/** Why an override cannot be used, or null when it can. Shared by the screen and the router. */
export function overrideProblem(o: VoiceOverride): string | null {
  if (!(VOICE_PROVIDERS as readonly string[]).includes(o.provider)) return `unknown voice provider "${o.provider}"`;
  if (o.provider === 'runway' && !(TTS_PRESET_IDS as readonly string[]).includes(o.voiceId)) return `"${o.voiceId}" is not a preset the voice vendor offers`;
  if (!o.voiceId.trim()) return 'empty voice id';
  return null;
}

export function voiceRouteFor(
  c: {
    name: string;
    voice: CharacterVoice;
    elevenlabs_voice_id?: string | null;
  },
  override?: VoiceOverride | null,
): VoiceRoute {
  // The override path: a row on the Voices screen. A malformed row is a refusal, never a
  // silent fall back to the bible — the person who set it believes it is in effect.
  if (override) {
    const problem = overrideProblem(override);
    if (problem) return { ok: false, code: 'voice_not_locked', detail: `${c.name}: the voice override is unusable — ${problem}. Change or clear it on the Voices screen.` };
    const provider = override.provider as VoiceProvider;
    return { ok: true, provider, voiceId: override.voiceId, integration: provider, model: DEFAULT_TTS_MODEL };
  }
  if (c.voice.provider === 'runway') {
    if (!c.voice.preset_id) {
      return {
        ok: false,
        code: 'voice_not_locked',
        detail:
          `${c.name} has no locked preset. Run \`pnpm voice:audition\`, pick one, then ` +
          '`pnpm voice:lock <character> <preset>`.',
      };
    }
    return { ok: true, provider: 'runway', voiceId: c.voice.preset_id, integration: 'runway', model: DEFAULT_TTS_MODEL };
  }
  if (!c.elevenlabs_voice_id) {
    return {
      ok: false,
      code: 'direct_voice_missing',
      detail: `${c.name} is routed to the direct voice vendor but has no elevenlabs_voice_id.`,
    };
  }
  return {
    ok: true,
    provider: 'elevenlabs',
    voiceId: c.elevenlabs_voice_id,
    integration: 'elevenlabs',
    model: DEFAULT_TTS_MODEL,
  };
}

/**
 * A stable, vendor-neutral string for `characters.voice_id` and `vo_takes.voice_id`.
 *
 * The model is part of the key whenever it is not the default (O5): a take is re-used only when
 * its key matches the current route, so a line spoken on v3 is never re-used under the second
 * model and vice versa — which is what keeps an overflowed episode on ONE model throughout.
 * The default model adds nothing, so every take recorded before this change keeps its key.
 */
export function voiceKey(route: Extract<VoiceRoute, { ok: true }>): string {
  return route.model === DEFAULT_TTS_MODEL ? `${route.provider}:${route.voiceId}` : `${route.provider}:${route.voiceId}@${route.model}`;
}

/** Where the default voice path's per-character rate lives in `rate_card`. */
export const TTS_RATE_KEY = {
  driver: 'runway',
  model: DEFAULT_TTS_MODEL,
  endpoint: '/v1/text_to_speech',
  unit: 'character',
} as const;

/** The rate-card row for a TTS model on the preset path (0040 seeds both). */
export function ttsRateKey(model: TtsModelName) {
  return { ...TTS_RATE_KEY, model };
}

// ═════════════════════════════════════════════════════════════════════════════
// The voice as the database stores it (channel_characters.voice, decision 0022)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `{provider, preset_id, direct_voice_id?}` — vendor-neutral keys, because the column and the
 * code that reads it live outside the driver layer (rule 1). This module is the only place
 * that maps them to and from the bible's vendor-named fields.
 */
export const StoredVoiceSchema = z.object({
  provider: z.enum(VOICE_PROVIDERS),
  preset_id: z.enum(TTS_PRESET_IDS).nullable(),
  direct_voice_id: z.string().min(1).nullable().optional(),
});
export type StoredVoice = z.infer<typeof StoredVoiceSchema>;

export function storedVoiceOf(c: { voice: CharacterVoice; elevenlabs_voice_id?: string | null }): StoredVoice {
  return { provider: c.voice.provider, preset_id: c.voice.preset_id, direct_voice_id: c.elevenlabs_voice_id ?? null };
}

/** The bible's two voice fields from a stored voice. Throws on a malformed one, by field. */
export function voiceFieldsFromStored(raw: unknown): { voice: CharacterVoice; elevenlabs_voice_id: string | null } {
  const v = StoredVoiceSchema.parse(raw);
  return { voice: { provider: v.provider, preset_id: v.preset_id }, elevenlabs_voice_id: v.direct_voice_id ?? null };
}

/** A stored voice from a Voices-screen override row (0046), for folding overrides into the cast. */
export function storedVoiceFromOverride(o: VoiceOverride, current: StoredVoice): StoredVoice | null {
  if (overrideProblem(o)) return null;
  return o.provider === 'runway'
    ? { provider: 'runway', preset_id: o.voiceId as StoredVoice['preset_id'], direct_voice_id: current.direct_voice_id ?? null }
    : { provider: 'elevenlabs', preset_id: current.preset_id, direct_voice_id: o.voiceId };
}

/** The default voice provider for a new character: the preset path. */
export const DEFAULT_VOICE_PROVIDER: VoiceProvider = 'runway';

/** The bible's voice keys, for a schema that edits a character without its voice. */
export const VOICE_FIELD_MASK = { voice: true, elevenlabs_voice_id: true } as const;

/** A stored voice locked to a preset, keeping any direct voice id already set. */
export function presetVoice(presetId: (typeof TTS_PRESET_IDS)[number], prev: Partial<StoredVoice> | null): StoredVoice {
  return { provider: DEFAULT_VOICE_PROVIDER, preset_id: presetId, direct_voice_id: prev?.direct_voice_id ?? null };
}
