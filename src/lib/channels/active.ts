import 'server-only';

import { cookies } from 'next/headers';

import { bibleForSlug, getBible, type ChannelBible } from '../bureau/bible';
import { serverClient } from '../db/server';
import { ACTIVE_CHANNEL_COOKIE, listChannels, pickActive, type ChannelSummary } from './list';

/**
 * The channel this browser is looking at — for screens and actions that are not acting on a
 * specific row. An action on a brief, episode, slot or publication reads the channel from
 * that row instead; the cookie never overrides a row.
 */
export async function currentChannel(): Promise<{ active: ChannelSummary | null; all: ChannelSummary[] }> {
  const store = await cookies();
  const all = await listChannels(serverClient());
  return { active: pickActive(all, store.get(ACTIVE_CHANNEL_COOKIE)?.value), all };
}

/**
 * Bibles read for this request's channel, keyed by channel id. `requireChannel` fills it with
 * `getBible` (database first, 0022) so the screens' synchronous `bibleOrNull(channel)` keeps
 * working without each page awaiting a second call. Overwritten on every `requireChannel`, so a
 * cast edit shows on the next page load. New screens should `await getBible(db, id)` directly.
 */
const read = new Map<string, ChannelBible | null>();

/** As `currentChannel`, but a screen that cannot render without a channel gets a sentence. */
export async function requireChannel(): Promise<ChannelSummary> {
  const { active } = await currentChannel();
  if (!active) throw new Error('No channel exists yet. Add one from the channel switcher at the top of the sidebar.');
  read.set(active.id, active.hasBible ? await getBible(serverClient(), active.id).catch(() => null) : null);
  return active;
}

/** The channel's bible (as `requireChannel` read it), or null when it has none. */
export function bibleOrNull(channel: ChannelSummary): ChannelBible | null {
  if (read.has(channel.id)) return read.get(channel.id) ?? null;
  return channel.slug && channel.hasBible ? (() => { try { return bibleForSlug(channel.slug!); } catch { return null; } })() : null;
}
