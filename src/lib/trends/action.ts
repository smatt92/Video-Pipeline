'use server';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';

/**
 * Run trend intake now.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Manual only, and that is the whole design
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ARCHITECTURE.md §4 says stage 1 is cron, four times daily, and it will be. It is not yet,
 * because a schedule is a decision about how often to hit somebody else's public feed and
 * that decision was not asked for.
 *
 * What this fixes is narrower and worth separating: `trendsTask` had **no caller at all**,
 * which put it straight back into the category the sweep had just pulled three other modules
 * out of. A stage reachable only from the Trigger dashboard is a stage that gets reported as
 * built and is not.
 *
 * So: a button's worth of surface, no schedule. When the cron lands it calls the same task
 * with the same payload, and this stays — a manual run is what you want when you have just
 * changed the subreddit list and do not want to wait six hours to see if it worked.
 *
 * ── Subreddits are explicit ──────────────────────────────────────────────────
 *
 * Passed in rather than defaulted, and `runTrends` fetches nothing when the list is empty.
 * A default list would be this file quietly deciding what the channel is about, and the
 * niche is the operator's judgement — a search query derived from it would be a guess
 * presented as a setting.
 */

export interface TrendsState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  runId?: string;
}

export async function runTrendsNowAction(subreddits: string[]): Promise<TrendsState> {
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return { status: 'error', message: 'Not signed in.' };
    if (!checkEmail(user.email).ok) return { status: 'error', message: 'Not permitted.' };

    const cleaned = subreddits
      .map((s) => s.trim().replace(/^\/?r\//, ''))
      .filter((s) => s.length >= 2);

    if (cleaned.length === 0) {
      return {
        status: 'error',
        message:
          'No subreddits given. Stage 1 fetches nothing rather than guessing at a default — ' +
          'what the channel is about is your judgement, not a query this can derive.',
      };
    }

    // Dynamic, like every other enqueue here: a Server Action that statically imports
    // `src/trigger/` pulls the SDK and every registered task into the route's bundle.
    const { trendsTask } = await import('@/trigger/01-trends');
    const handle = await trendsTask.trigger({ subreddits: cleaned });

    return {
      status: 'ok',
      runId: handle.id,
      message:
        `Collecting from ${cleaned.length} subreddit${cleaned.length === 1 ? '' : 's'}. ` +
        'Signals land in the trend table and stage 2 reads the newest 25 when it next runs.',
    };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
