import { logger, schedules } from '@trigger.dev/sdk';

import { listChannels } from '@/lib/channels/list';
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
  // 06:45 IST, written in UTC. Trigger.dev's deploy rejected timezone 'Asia/Kolkata' by name
  // ("Invalid IANA timezone"), and India has no daylight saving, so UTC+05:30 is exact all
  // year and no zone name is needed.
  cron: '15 1 * * *',
  queue: { concurrencyLimit: 1 },

  run: async () => {
    const db = serverClient();
    // Every channel with a bible in this build, each on its own kill switch and its own slots.
    // A channel without a bible is skipped by name — it has no cast to draft for.
    const channels = await listChannels(db);
    const results: Record<string, unknown> = {};
    let apiKey: string | null = null;
    let usdInrRate: number | null = null;
    for (const ch of channels) {
      if (!ch.hasBible) {
        results[ch.name] = { skipped: `no bible folder for slug ${ch.slug ?? '(none)'}` };
        continue;
      }
      const { data: policy } = await db.from('channel_policy').select('kill_switch').eq('channel_id', ch.id).maybeSingle();
      if (policy?.kill_switch) {
        logger.info('kill switch is on; drafting nothing', { channel: ch.name });
        results[ch.name] = { drafted: 0, skipped: 'kill_switch' };
        continue;
      }

      const today = new Date();
      const horizon = new Date(today.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
      const { data: slots } = await db
        .from('v_slot_status')
        .select('id, slot_date, production_status, kind')
        .eq('channel_id', ch.id)
        .gte('slot_date', today.toISOString().slice(0, 10))
        .lte('slot_date', horizon)
        .eq('production_status', 'open');

      const open = (slots ?? []).filter((s) => s.kind === 'short');
      if (open.length === 0) {
        results[ch.name] = { drafted: 0, open: 0 };
        continue;
      }

      apiKey ??= await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');
      usdInrRate ??= await requireUsdInrRate(db, 'writing the cost rows for 19-draft-briefs');

      let drafted = 0;
      for (const slot of open) {
        try {
          const draft = await draftBriefForSlot(db, slot.id!, { db, apiKey, usdInrRate, channelId: ch.id });
          if (!draft.ok) {
            logger.error('draft did not validate', { channel: ch.name, slot: slot.id, error: draft.error });
            continue;
          }
          const [r] = await createBriefs([draft.brief], {
            db,
            token: { id: null, scope: 'system', channelId: ch.id, profileId: null, name: '19-draft-briefs' },
          });
          if (r.ok) drafted++;
          else logger.error('brief refused', { channel: ch.name, slot: slot.id, error: r.error });
        } catch (err) {
          logger.error('drafting failed', { channel: ch.name, slot: slot.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (drafted) {
        await notify(db, ch.id, 'briefs_pending', `${drafted} slot${drafted === 1 ? '' : 's'} within two days had no brief, so Kiln drafted ${drafted === 1 ? 'one' : 'them'}. Pick a punchline on Approvals.`);
      }
      results[ch.name] = { drafted, open: open.length };
    }
    return results;
  },
});
