import 'server-only';

import { cookies } from 'next/headers';

import { bibleForSlug } from '../bureau/bible';
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

/** As `currentChannel`, but a screen that cannot render without a channel gets a sentence. */
export async function requireChannel(): Promise<ChannelSummary> {
  const { active } = await currentChannel();
  if (!active) throw new Error('No channel exists yet. Add one from the channel switcher at the top of the sidebar.');
  return active;
}

/** The active channel's bible, or null when its slug has no folder in this build. */
export function bibleOrNull(channel: ChannelSummary) {
  return channel.slug && channel.hasBible ? bibleForSlug(channel.slug) : null;
}
