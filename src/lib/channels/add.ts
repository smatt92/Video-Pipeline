import { z } from 'zod';

import type { Db } from '../db/server';

/**
 * A channel's publish targets. Adding a channel moved to `createChannel` (bible-admin.ts,
 * decision 0022), which writes the bible to the database instead of requiring a folder.
 */

export const TargetSchema = z.object({
  platform: z.enum(['youtube', 'instagram']),
  enabled: z.boolean(),
  handle: z.string().trim().max(60).optional().transform((v) => (v ? v.replace(/^@?/, '@') : null)),
  external_id: z.string().trim().max(40).optional().transform((v) => v || null),
});

/**
 * Set one publish target of an existing channel — the Instagram account of the Bureau, which
 * 0046 seeds with no account id, is the case this exists for. Upsert on (channel, platform).
 */
export async function setPublishTarget(db: Db, channelId: string, raw: z.input<typeof TargetSchema>): Promise<{ ok: true } | { ok: false; refused: string }> {
  const p = TargetSchema.safeParse(raw);
  if (!p.success) return { ok: false, refused: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const t = p.data;
  if (t.external_id && t.platform === 'youtube' && !/^UC[A-Za-z0-9_-]{22}$/.test(t.external_id)) return { ok: false, refused: 'A YouTube channel id starts UC and is 24 characters.' };
  if (t.external_id && t.platform === 'instagram' && !/^\d{5,25}$/.test(t.external_id)) return { ok: false, refused: 'An Instagram professional account id is digits.' };
  const { data: ch } = await db.from('channels').select('id').eq('id', channelId).maybeSingle();
  if (!ch) return { ok: false, refused: 'No such channel.' };
  const { error } = await db
    .from('channel_publish_targets')
    .upsert({ channel_id: channelId, platform: t.platform, enabled: t.enabled, handle: t.handle, external_id: t.external_id }, { onConflict: 'channel_id,platform' });
  if (error) return { ok: false, refused: `Saving the target failed: ${error.message} — if the table is missing, paste the 0046 bundle.` };
  return { ok: true };
}
