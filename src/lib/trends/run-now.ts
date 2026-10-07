import { bibleForSlug, type TrendsConfig } from '../bureau/bible';
import { listChannels } from '../channels/list';
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
  trendsFor?: (slug: string) => TrendsConfig;
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
  if (!ch.slug || !ch.hasBible) {
    return refuse(`“${ch.name}” has no bible folder in this build (slug ${ch.slug ?? 'unset'}), so it has no trends.json — nothing to collect from.`);
  }

  const trends = (deps.trendsFor ?? ((s: string) => bibleForSlug(s).trends))(ch.slug);
  const yt = trends.youtube;
  const ytConfigured = !!yt && (yt.category_ids.length > 0 || yt.queries.length > 0);
  const payload: TrendsNowPayload = {
    channelId: ch.id,
    subreddits: [...trends.subreddits],
    youtube: yt ? { region_code: yt.region_code, category_ids: [...yt.category_ids], queries: [...yt.queries] } : null,
  };

  if (payload.subreddits.length === 0 && !ytConfigured) {
    return refuse(
      `channels/${ch.slug}/trends.json lists no subreddits and no YouTube categories or queries. Stage 1 fetches nothing rather than guessing what the channel is about.`,
    );
  }

  const handle = await deps.trigger(payload);
  const parts = [
    payload.subreddits.length ? `${payload.subreddits.length} subreddit${payload.subreddits.length === 1 ? '' : 's'}` : null,
    ytConfigured && yt
      ? `YouTube (${yt.category_ids.length} categor${yt.category_ids.length === 1 ? 'y' : 'ies'}, ${yt.queries.length} quer${yt.queries.length === 1 ? 'y' : 'ies'})`
      : null,
  ].filter(Boolean);
  return {
    status: 'ok',
    runId: handle.id,
    message: `Collecting for ${ch.name} from ${parts.join(' and ')}. Reload in a minute to see the signals.`,
  };
}
