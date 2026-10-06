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

export function voiceRouteFor(c: {
  name: string;
  voice: CharacterVoice;
  elevenlabs_voice_id?: string | null;
}): VoiceRoute {
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

/** A stable, vendor-neutral string for `characters.voice_id` and `vo_takes.voice_id`. */
export function voiceKey(route: Extract<VoiceRoute, { ok: true }>): string {
  return `${route.provider}:${route.voiceId}`;
}
