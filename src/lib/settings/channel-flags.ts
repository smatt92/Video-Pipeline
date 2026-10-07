import { z } from 'zod';

import type { Db } from '../db/server';

/**
 * Two per-channel values from migration 0051, read apart from `readTuning` on purpose.
 *
 * `readTuning` names every 0049 column in one select and falls back to the constants for ALL
 * of them when any is missing. Folding these two in would make every channel lose its tuned
 * picture/voice/assembly numbers on the hosted project until bundle 9 is pasted — a paste
 * that the code must not need in order to keep working. So they have their own reader with
 * the same probe: a missing column → the defaults below and the reason, never a throw.
 *
 *   relevanceThreshold  /trends "For this channel" and stage 2's first pick (0..1, cosine)
 *   voiceOverflow       re-voice the whole episode on the second model at the daily limit
 */

/**
 * 0.65. The channel's niche vector is the normalised mean of its premise, series and calendar
 * topics, so a term is compared with the channel's centre of gravity, not its best-matching
 * topic; on this embedding model unrelated short texts commonly land around 0.5–0.6 against
 * such a centre and on-topic ones above 0.65–0.7. That is a starting point measured on no real
 * signal of ours (the embeddings key is not reachable from the build container) — /trends
 * prints every signal's score beside the threshold so it can be set from the real spread.
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.65;

export const CHANNEL_FLAG_DEFAULTS = { relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD, voiceOverflow: false } as const;

export const ChannelFlagsSchema = z.object({
  relevanceThreshold: z.number().min(0).max(1),
  voiceOverflow: z.boolean(),
});
export type ChannelFlags = z.infer<typeof ChannelFlagsSchema>;

export const CHANNEL_FLAG_COLUMNS = { relevanceThreshold: 'relevance_threshold', voiceOverflow: 'voice_overflow' } as const satisfies Record<keyof ChannelFlags, string>;

export const FLAGS_NEED_0051 =
  'These settings need migration 0051 (paste docs/bureau/hosted-migrations-9-0051.sql); until then relevance is not scored, the threshold is the built-in 0.65 and voice overflow is off.';

export type ChannelFlagsRead =
  | { source: 'channel'; values: ChannelFlags }
  | { source: 'defaults'; values: ChannelFlags; reason: string };

const isMissingColumn = (msg: string) => /column .* does not exist|could not find .* column|schema cache/i.test(msg);

export async function readChannelFlags(db: Db, channelId: string): Promise<ChannelFlagsRead> {
  const { data, error } = await db.from('channel_policy').select('relevance_threshold, voice_overflow').eq('channel_id', channelId).maybeSingle();
  if (error) {
    if (isMissingColumn(error.message)) return { source: 'defaults', values: { ...CHANNEL_FLAG_DEFAULTS }, reason: FLAGS_NEED_0051 };
    throw new Error(`Reading channel_policy: ${error.message}`);
  }
  if (!data) return { source: 'defaults', values: { ...CHANNEL_FLAG_DEFAULTS }, reason: 'This channel has no policy row; the built-in values apply.' };
  // numeric arrives as a string: Number() at this boundary is a decision — a value the CHECK
  // keeps between 0 and 1.
  const parsed = ChannelFlagsSchema.safeParse({ relevanceThreshold: Number(data.relevance_threshold), voiceOverflow: data.voice_overflow });
  if (!parsed.success) throw new Error(`channel_policy holds a value outside its range: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  return { source: 'channel', values: parsed.data };
}

/**
 * What switching voice overflow on costs, from the rows: the second model's rate-card price ×
 * the mean characters of this channel's last ten voiced episodes × the stored FX rate. The
 * ceiling, not the usual case — only lines already spoken on the main model are re-bought, and
 * the rest were priced by the first pass. Absent when any input is absent, with the reason.
 */
export async function overflowCostPerShort(db: Db, channelId: string): Promise<{ ok: true; inr: number; chars: number; episodes: number } | { ok: false; reason: string }> {
  const [{ currentRate }, { readUsdInrRate }, { OVERFLOW_TTS_MODEL, ttsRateKey }] = await Promise.all([
    import('../cost/rate-card'),
    import('../cost/fx'),
    import('../drivers/voice-route'),
  ]);
  const rate = await currentRate(db, { ...ttsRateKey(OVERFLOW_TTS_MODEL) });
  if (!rate.found) return { ok: false, reason: `no rate for the second voice model (${rate.detail})` };
  const fx = await readUsdInrRate(db);
  if (!fx.ok) return { ok: false, reason: fx.reason };
  const { data } = await db.from('episodes').select('voice_detail').eq('channel_id', channelId).not('voice_detail', 'is', null).order('updated_at', { ascending: false }).limit(10);
  const chars = (data ?? []).map((e) => Number((e.voice_detail as { chars?: unknown } | null)?.chars)).filter((n) => Number.isFinite(n) && n > 0);
  if (!chars.length) return { ok: false, reason: 'no episode on this channel has been voiced yet, so there is no script length to price' };
  const mean = chars.reduce((a, b) => a + b, 0) / chars.length;
  return { ok: true, inr: Math.round(mean * rate.rate.unitCostUsd * fx.rate * 100) / 100, chars: Math.round(mean), episodes: chars.length };
}
