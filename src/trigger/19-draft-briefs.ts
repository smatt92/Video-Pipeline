import { logger, schedules } from '@trigger.dev/sdk';

import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import { draftBriefForSlot } from '@/lib/bureau/brief-generator';
import { createBriefs } from '@/lib/bureau/briefs';
import { notify } from '@/lib/bureau/alerts';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { requireCredential } from '@/lib/integrations/credentials';

/**
 * The brief safety net. 06:45 IST daily, 45 minutes after Routine C (the Showrunner).
 *
 * Routine C drafts briefs through the MCP tools; this task drafts only for a dated slot two
 * days out (or sooner) that STILL has no live brief — the case where the Routine failed or
 * skipped it. One server-side draft per such slot, writer tier, ledgered by the router, and
 * submitted as `system` with the server's own policy and variation checks, exactly as an
 * agent-drafted brief would be. It never approves; Sahil still picks the punchline.
 *
 * Caller: the Trigger schedule (deployed with the worker). Nothing else invokes it.
 */
export const draftBriefsTask = schedules.task({
  id: '19-draft-briefs',
  cron: { pattern: '45 6 * * *', timezone: 'Asia/Kolkata' },
  queue: { concurrencyLimit: 1 },

  run: async () => {
    const db = serverClient();
    const { data: policy } = await db.from('channel_policy').select('kill_switch').eq('channel_id', BUREAU_CHANNEL_ID).single();
    if (policy?.kill_switch) {
      logger.info('kill switch is on; drafting nothing');
      return { drafted: 0, skipped: 'kill_switch' };
    }

    const today = new Date();
    const horizon = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
    const { data: slots } = await db
      .from('v_slot_status')
      .select('id, slot_date, production_status, kind')
      .eq('channel_id', BUREAU_CHANNEL_ID)
      .gte('slot_date', today.toISOString().slice(0, 10))
      .lte('slot_date', horizon)
      .eq('production_status', 'open');

    const open = (slots ?? []).filter((s) => s.kind === 'short');
    if (open.length === 0) return { drafted: 0, open: 0 };

    const apiKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');
    const usdInrRate = await requireUsdInrRate(db, 'writing the cost rows for 19-draft-briefs');

    let drafted = 0;
    for (const slot of open) {
      try {
        const draft = await draftBriefForSlot(db, slot.id!, { db, apiKey, usdInrRate, channelId: BUREAU_CHANNEL_ID });
        if (!draft.ok) {
          logger.error('draft did not validate', { slot: slot.id, error: draft.error });
          continue;
        }
        const [r] = await createBriefs([draft.brief], {
          db,
          token: { id: null, scope: 'system', channelId: BUREAU_CHANNEL_ID, profileId: null, name: '19-draft-briefs' },
        });
        if (r.ok) drafted++;
        else logger.error('brief refused', { slot: slot.id, error: r.error });
      } catch (err) {
        logger.error('drafting failed', { slot: slot.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (drafted) {
      await notify(db, BUREAU_CHANNEL_ID, 'briefs_pending', `${drafted} slot${drafted === 1 ? '' : 's'} within 2 days had no brief; the safety net drafted ${drafted === 1 ? 'one' : 'them'}.`);
    }
    return { drafted, open: open.length };
  },
});
