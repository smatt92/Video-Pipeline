'use server';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient } from '../db/server';
import { startTrendsRun, type TrendsState } from './run-now';

/**
 * Run trend intake now, for one channel. Caller: the Run now button on /trends
 * (`src/components/trends/run-now.tsx`), which the page renders with the active channel's id
 * from `requireChannel()`.
 *
 * The schedule (`01-trends`, four times a day) covers every channel on its own; this is for
 * the moment you have just changed a channel's `trends.json` and do not want to wait six
 * hours to see whether it worked.
 *
 * Everything that decides — approver, channel, sources — is in `startTrendsRun`
 * (`run-now.ts`), which `verify:trends` drives: a `'use server'` module cannot be imported by
 * a harness, so a refusal written here would be a refusal nothing tests. This file only
 * resolves the session and the task.
 */
export async function runTrendsNowAction(channelId: string): Promise<TrendsState> {
  try {
    const supabase = await routeClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    return await startTrendsRun(serverClient(), channelId, {
      user: user ? { id: user.id, emailAllowed: checkEmail(user.email).ok } : null,
      trigger: async (payload) => {
        // Dynamic, like every other enqueue here: a Server Action that statically imports
        // `src/trigger/` pulls the SDK and every registered task into the route's bundle.
        const { trendsNowTask } = await import('@/trigger/01-trends');
        const handle = await trendsNowTask.trigger(payload);
        return { id: handle.id };
      },
    });
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
