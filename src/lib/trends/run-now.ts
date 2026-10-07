import { getBible, type TrendsConfig } from '../bureau/bible';
import { listChannels } from '../channels/list';
import { DEFAULT_GOOGLE_TRENDS_GEOS } from '../drivers/trends-google';
import { DEFAULT_HN_TOP_N } from '../drivers/trends-hn';
import { DEFAULT_WIKIPEDIA_LANGUAGES } from '../drivers/trends-wikipedia';
import type { Db } from '../db/server';

/**
 * The decision behind the Run now button on /trends, outside the `'use server'` module so a
 * harness can drive it (`verify:trends` §9). `action.ts` resolves the session and the task
 * handle and hands them here; every refusal is in this function.
 *
 * The sources are the channel's own `channels/<slug>/trends.json`, never a typed list: what
 * a channel watches is a commit to its bible, reviewed like the rest of it, not a field
 * somebody fills in on the day.
 *
 * ── Who may press it ─────────────────────────────────────────────────────────
 *
 * The approver: signed in, on the allow-list, AND with a `profiles` row — the same test
 * Settings → MCP tokens applies before minting an approver token. The app is single-user, so
 * this is one person; the profile row is what makes them the approver rather than merely an
 * address that passed sign-in. Each missing piece refuses by naming itself.
 */

export interface TrendsNowPayload {
  readonly channelId: string;
  readonly subreddits: string[];
  readonly youtube: NonNullable<TrendsConfig['youtube']> | null;
  /** Present only when the channel's trend sources say; absent → the default countries. */
  readonly google_trends?: TrendsConfig['google_trends'];
  /** Present only when the channel's trend sources say; absent → on with the defaults. */
  readonly wikipedia?: TrendsConfig['wikipedia'];
  readonly hn?: TrendsConfig['hn'];
}

export interface TrendsState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  runId?: string;
}

export interface StartTrendsRunDeps {
  /** The signed-in user (null = no session) and whether `checkEmail` admitted their address. */
  user: { id: string; emailAllowed: boolean } | null;
  /** Enqueues `01-trends-now`. The action passes the task's `trigger`; a harness, a recorder. */
  trigger(payload: TrendsNowPayload): Promise<{ id: string }>;
  /** Defaults to the build's bible folders. */
  /** By channel id; production reads `getBible` (database first, 0022). */
  trendsFor?: (channelId: string) => TrendsConfig | Promise<TrendsConfig>;
}

export async function startTrendsRun(db: Db, channelId: string, deps: StartTrendsRunDeps): Promise<TrendsState> {
  const refuse = (message: string): TrendsState => ({ status: 'error', message: `refused: ${message}` });

  if (!deps.user) return refuse('not signed in. Run now is for the approver.');
  if (!deps.user.emailAllowed) return refuse('this address is not on ALLOWED_EMAIL. Run now is for the approver.');
  const { data: profile, error: profileErr } = await db.from('profiles').select('id').eq('id', deps.user.id).maybeSingle();
  if (profileErr) return refuse(`could not read profiles (${profileErr.message}), so the approver could not be confirmed.`);
  if (!profile) return refuse('the signed-in user has no profiles row, so is not the approver. Finish onboarding first.');

  const ch = (await listChannels(db)).find((c) => c.id === channelId);
  if (!ch) return refuse(`channel ${channelId} is not an active channel.`);
  if (!ch.hasBible) {
    return refuse(`“${ch.name}” has no bible (slug ${ch.slug ?? 'unset'}), so it has no trend sources — nothing to collect from.`);
  }

  const trends = await (deps.trendsFor ?? (async (id: string) => (await getBible(db, id)).trends))(ch.id);
  const yt = trends.youtube;
  const ytConfigured = !!yt && (yt.category_ids.length > 0 || yt.queries.length > 0);
  const payload: TrendsNowPayload = {
    channelId: ch.id,
    subreddits: [...trends.subreddits],
    youtube: yt ? { region_code: yt.region_code, category_ids: [...yt.category_ids], queries: [...yt.queries] } : null,
    ...(trends.google_trends !== undefined ? { google_trends: trends.google_trends } : {}),
    ...(trends.wikipedia !== undefined ? { wikipedia: trends.wikipedia } : {}),
    ...(trends.hn !== undefined ? { hn: trends.hn } : {}),
  };
  // Google Trends is read unless the channel turns it off (null): it needs no key and no list.
  const googleOn = trends.google_trends !== null;
  // Wikipedia and Hacker News likewise: no key, so on unless turned off (null).
  const wikiOn = trends.wikipedia !== null;
  const hnOn = trends.hn !== null;

  if (payload.subreddits.length === 0 && !ytConfigured && !googleOn && !wikiOn && !hnOn) {
    return refuse(
      `${ch.name}'s trend sources list no subreddits, no YouTube categories or queries, and turn Google Trends, Wikipedia and Hacker News off. Stage 1 fetches nothing rather than guessing what the channel is about.`,
    );
  }

  const handle = await deps.trigger(payload);
  const parts = [
    payload.subreddits.length ? `${payload.subreddits.length} subreddit${payload.subreddits.length === 1 ? '' : 's'}` : null,
    ytConfigured && yt
      ? `YouTube (${yt.category_ids.length} categor${yt.category_ids.length === 1 ? 'y' : 'ies'}, ${yt.queries.length} quer${yt.queries.length === 1 ? 'y' : 'ies'})`
      : null,
    googleOn ? `Google Trends (${(trends.google_trends?.geo ?? DEFAULT_GOOGLE_TRENDS_GEOS).join(', ')})` : null,
    wikiOn ? `Wikipedia (${(trends.wikipedia?.languages ?? DEFAULT_WIKIPEDIA_LANGUAGES).join(', ')})` : null,
    hnOn ? `Hacker News (top ${trends.hn?.top_n ?? DEFAULT_HN_TOP_N})` : null,
  ].filter(Boolean);
  return {
    status: 'ok',
    runId: handle.id,
    message: `Collecting for ${ch.name} from ${parts.join(' and ')}. Reload in a minute to see the signals.`,
  };
}
