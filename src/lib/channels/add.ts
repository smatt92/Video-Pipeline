import { z } from 'zod';

import { bibleForSlug, hasBible, syncCast, BIBLE_SLUGS } from '../bureau/bible';
import type { Db } from '../db/server';

/**
 * Add a channel: the row, its policy, its publish targets, its cast — in that order, and only
 * when the bible folder for its slug is in this build.
 *
 * ── Why the bible is not copied here ─────────────────────────────────────────
 *
 * A bible is files in the repo (channels/<slug>/), reviewed like code and bundled into both
 * deploys. Vercel cannot write to the repo, so "copy the template" is `pnpm channel:new
 * <slug>` on a laptop, then a commit and a deploy. This function refuses a slug whose folder
 * is not in the build, by name, with that command — rather than creating a channel row that
 * every Bureau screen and task would then refuse one at a time.
 */

export const AddChannelSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and hyphens'),
  handle: z.string().trim().max(60).optional().transform((v) => (v ? v.replace(/^@?/, '@') : null)),
  niche: z.string().trim().max(200).optional(),
  youtube_channel_id: z.string().trim().regex(/^UC[A-Za-z0-9_-]{22}$/, 'a YouTube channel id starts UC and is 24 characters').optional().or(z.literal('').transform(() => undefined)),
  instagram_account_id: z.string().trim().regex(/^\d{5,25}$/, 'an Instagram professional account id is digits').optional().or(z.literal('').transform(() => undefined)),
  instagram_handle: z.string().trim().max(60).optional().transform((v) => (v ? v.replace(/^@?/, '@') : null)),
  targets: z.array(z.enum(['youtube', 'instagram'])).min(1, 'pick at least one platform'),
});
export type AddChannelInput = z.input<typeof AddChannelSchema>;

export type AddChannelResult =
  | { ok: true; channelId: string; slug: string; cast: number; targets: string[]; warnings: string[] }
  | { ok: false; refused: string };

export async function addChannel(db: Db, raw: AddChannelInput): Promise<AddChannelResult> {
  const parsed = AddChannelSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, refused: parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') };
  const input = parsed.data;

  if (!hasBible(input.slug)) {
    return {
      ok: false,
      refused:
        `No bible folder channels/${input.slug}/ in this build. On your laptop run \`pnpm channel:new ${input.slug}\` ` +
        `(it copies channels/_template/), edit the cast and series, commit, push, and deploy the worker; then add the channel here. ` +
        `Folders in this build: ${BIBLE_SLUGS.join(', ') || 'none'}.`,
    };
  }
  const { data: taken } = await db.from('channels').select('id, name').eq('slug', input.slug).maybeSingle();
  if (taken) return { ok: false, refused: `The slug "${input.slug}" already belongs to channel "${taken.name}".` };

  const cb = bibleForSlug(input.slug);
  const primary = input.targets.includes('youtube') ? 'youtube' : 'instagram';
  const { data: ch, error } = await db
    .from('channels')
    .insert({
      name: input.name,
      slug: input.slug,
      handle: input.handle,
      niche: input.niche || cb.bible.world.premise,
      platform: primary,
      external_id: primary === 'youtube' ? (input.youtube_channel_id ?? null) : (input.instagram_account_id ?? null),
      is_active: true,
    })
    .select('id')
    .single();
  if (error || !ch) return { ok: false, refused: `Creating the channel failed: ${error?.message ?? 'no row'}` };

  const warnings: string[] = [];
  const { error: polErr } = await db.from('channel_policy').insert({ channel_id: ch.id });
  if (polErr) warnings.push(`channel policy: ${polErr.message}`);

  const rows = input.targets.map((p) => ({
    channel_id: ch.id,
    platform: p,
    enabled: true,
    handle: p === 'instagram' ? input.instagram_handle : input.handle,
    external_id: p === 'instagram' ? (input.instagram_account_id ?? null) : (input.youtube_channel_id ?? null),
  }));
  const { error: tErr } = await db.from('channel_publish_targets').insert(rows);
  if (tErr) warnings.push(`publish targets were not recorded (${tErr.message}) — paste the 0046 bundle; until then the channel publishes to ${primary} only`);

  const cast = await syncCast(db as unknown as Parameters<typeof syncCast>[0], ch.id, cb);
  return { ok: true, channelId: ch.id, slug: input.slug, cast: cast.synced, targets: input.targets, warnings };
}
