import type { Db } from '../db/server';

/**
 * Step 8 — First channel — without making a second one.
 *
 * Migration 0037 seeds the Bureau channel, and on the hosted project its handle and external
 * id were set by hand on 06-Oct. The step used to INSERT unconditionally, so running it there
 * would have created a second channel that nothing in the Bureau control plane uses: tokens,
 * briefs, slots and publications all point at the seeded row. "Concepts cannot exist without
 * a channel" is the step's reason, and an active channel already satisfies it.
 *
 * So the rule, decided here and not by which form the page happened to render: **if an
 * active channel exists, the step completes without inserting** — at most it edits that
 * channel's handle. Only a workspace with no active channel gets a new row.
 */

export interface ChannelRow {
  id: string;
  name: string;
  platform: string;
  niche: string;
  handle: string | null;
  external_id: string | null;
}

const COLUMNS = 'id, name, platform, niche, handle, external_id';

/** The channel the step would use: `preferredId` if it is active, else the oldest active one. */
export async function activeChannel(db: Db, preferredId: string | null): Promise<ChannelRow | null> {
  if (preferredId) {
    const { data, error } = await db
      .from('channels')
      .select(COLUMNS)
      .eq('id', preferredId)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw new Error(`Reading channels failed: ${error.message}`);
    if (data) return data;
  }
  const { data, error } = await db
    .from('channels')
    .select(COLUMNS)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw new Error(`Reading channels failed: ${error.message}`);
  return data?.[0] ?? null;
}

export interface ChannelStepInput {
  name: string;
  platform: string;
  niche: string;
  handle: string;
}

export type ChannelStepResult =
  | { ok: true; inserted: boolean; handleChanged: boolean; channel: ChannelRow }
  | { ok: false; message: string };

/** A handle as YouTube and Instagram write it: one leading @, no spaces. Empty means "leave it". */
export function normaliseHandle(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  return t.startsWith('@') ? t : `@${t}`;
}

export async function completeChannelStep(
  db: Db,
  input: ChannelStepInput,
  preferredId: string | null,
): Promise<ChannelStepResult> {
  const handle = normaliseHandle(input.handle);
  if (handle && !/^@[A-Za-z0-9._-]{1,100}$/.test(handle)) {
    return { ok: false, message: `"${input.handle}" is not a handle: letters, digits, dot, dash and underscore after one @.` };
  }

  const existing = await activeChannel(db, preferredId);
  if (existing) {
    if (!handle || handle === existing.handle) {
      return { ok: true, inserted: false, handleChanged: false, channel: existing };
    }
    const { data, error } = await db
      .from('channels')
      .update({ handle })
      .eq('id', existing.id)
      .select(COLUMNS)
      .single();
    if (error || !data) throw new Error(`Updating the channel handle failed: ${error?.message ?? 'no row'}`);
    return { ok: true, inserted: false, handleChanged: true, channel: data };
  }

  const name = input.name.trim();
  const platform = input.platform.trim().toLowerCase();
  const niche = input.niche.trim();
  if (!name || !platform || !niche) {
    return { ok: false, message: 'Name, platform and niche are all required.' };
  }
  if (platform !== 'youtube' && platform !== 'instagram') {
    return { ok: false, message: `Platform must be youtube or instagram; got "${input.platform}".` };
  }
  const { data, error } = await db
    .from('channels')
    .insert({ name, platform, niche, handle, is_active: true })
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Channel insert returned nothing.');
  return { ok: true, inserted: true, handleChanged: false, channel: data };
}
