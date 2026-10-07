import { hasBible } from '../bureau/bible';
import type { Db } from '../db/server';

/**
 * Which channels exist, and which one a browser is looking at.
 *
 * Pure enough for a harness (a Db and a string in, a row out); the cookie read and write live
 * in `active.ts` and `actions.ts`, which only the framework can run.
 */

/** The cookie that holds the active channel id, per browser. Not a secret: a channel id. */
export const ACTIVE_CHANNEL_COOKIE = 'kiln_channel';

export interface ChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly handle: string | null;
  readonly slug: string | null;
  /** Its bible folder is in this build — the Bureau lane can draft for it. */
  readonly hasBible: boolean;
}

export async function listChannels(db: Db): Promise<ChannelSummary[]> {
  const { data, error } = await db
    .from('channels')
    .select('id, name, handle, slug, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Reading channels: ${error.message}`);
  return (data ?? []).map((c) => ({ id: c.id, name: c.name, handle: c.handle, slug: c.slug, hasBible: !!c.slug && hasBible(c.slug) }));
}

/**
 * The cookie's channel when it names an active channel; otherwise the oldest channel with a
 * bible (the Bureau, on this workspace — it was the first); otherwise the oldest channel;
 * otherwise null. A stale cookie (a channel deactivated since) falls through rather than
 * showing an empty screen for a channel nobody can see in the switcher.
 */
export function pickActive(channels: readonly ChannelSummary[], cookieValue: string | null | undefined): ChannelSummary | null {
  const fromCookie = cookieValue ? channels.find((c) => c.id === cookieValue) : undefined;
  return fromCookie ?? channels.find((c) => c.hasBible) ?? channels[0] ?? null;
}

export async function resolveActiveChannel(db: Db, cookieValue: string | null | undefined): Promise<ChannelSummary | null> {
  return pickActive(await listChannels(db), cookieValue);
}

/**
 * Publish targets for a channel. A missing table (0046 not pasted yet) reads as the channel's
 * own `platform` column, which is exactly what a channel's target was before the table.
 */
export interface PublishTarget {
  readonly platform: 'youtube' | 'instagram';
  readonly enabled: boolean;
  readonly handle: string | null;
  readonly externalId: string | null;
}

export async function publishTargets(db: Db, channelId: string): Promise<{ targets: PublishTarget[]; fromTable: boolean }> {
  const { data, error } = await db.from('channel_publish_targets').select('platform, enabled, handle, external_id').eq('channel_id', channelId).order('platform');
  if (!error) {
    return {
      fromTable: true,
      targets: (data ?? []).map((t) => ({ platform: t.platform === 'instagram' ? 'instagram' : 'youtube', enabled: t.enabled, handle: t.handle, externalId: t.external_id })),
    };
  }
  const { data: ch } = await db.from('channels').select('platform, handle, external_id').eq('id', channelId).maybeSingle();
  return {
    fromTable: false,
    targets: ch ? [{ platform: ch.platform === 'instagram' ? 'instagram' : 'youtube', enabled: true, handle: ch.handle, externalId: ch.external_id }] : [],
  };
}
