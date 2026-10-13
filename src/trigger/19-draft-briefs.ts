import { logger, schedules } from '@trigger.dev/sdk';

import { listChannels } from '@/lib/channels/list';
import { SAFETY_NET_SUBMIT_HOUR_UTC, briefBatchCustomId, briefBatchKey, draftBriefForSlotBatched, type GenerateResult } from '@/lib/bureau/brief-generator';
import { createBriefs } from '@/lib/bureau/briefs';
import { notify } from '@/lib/bureau/alerts';
import { requireUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { requireCredential } from '@/lib/integrations/credentials';
import { sweepBatches } from '@/lib/llm/batch';

/**
 * The brief safety net. 06:45 IST daily, 45 minutes after Routine C (the Showrunner).
 *
 * Routine C drafts briefs through the MCP tools; this task drafts only for a dated slot two
 * days out (or sooner) that STILL has no live brief — the case where the Routine failed or
 * skipped it. One server-side draft per such slot, writer tier, ledgered by the router, and
 * submitted as `system` with the server's own policy and variation checks, exactly as an
 * agent-drafted brief would be. It never approves; Sahil still picks the punchline.
 *
 * Batched since 13-Oct (llm/batch.ts): the drafts are sent at 06:45 IST exactly as before, through
 * the Message Batches API at half the price, and this task now runs hourly so a later tick can
 * collect them — usually the next one. The hourly ticks only collect; nothing is submitted
 * outside the 06:45 hour, so the net never races Routine C. A draft whose slot was filled in the
 * meantime is collected (its cost is reconciled) and discarded. The 3D explainer's writer is not
 * batched and drafts synchronously at 06:45, as it always did.
 *
 * Caller: the Trigger schedule (deployed with the worker). Nothing else invokes it.
 */
export const draftBriefsTask = schedules.task({
  id: '19-draft-briefs',
  // Hourly at :15. Drafts are SUBMITTED only in the 01:15 UTC tick (06:45 IST, written in UTC:
  // Trigger.dev's deploy rejected timezone 'Asia/Kolkata' by name, and India has no daylight
  // saving, so UTC+05:30 is exact all year); every tick collects.
  cron: '15 * * * *',
  queue: { concurrencyLimit: 1 },

  run: async () => {
    const db = serverClient();
    const now = new Date();
    const submitting = now.getUTCHours() === SAFETY_NET_SUBMIT_HOUR_UTC;
    const results: Record<string, unknown> = {};
    let apiKey: string | null = null;
    let usdInrRate: number | null = null;
    const drafted = new Map<string, number>();

    const openSlot = async (slotId: string) => {
      const { data } = await db.from('v_slot_status').select('production_status').eq('id', slotId).maybeSingle();
      return data?.production_status === 'open';
    };
    const land = async (channelId: string, name: string, slotId: string, result: GenerateResult) => {
      if (!result.ok) {
        logger.error('draft did not validate', { channel: name, slot: slotId, error: result.error });
        return;
      }
      const [r] = await createBriefs([result.brief], {
        db,
        token: { id: null, scope: 'system', channelId, profileId: null, name: '19-draft-briefs' },
      });
      if (r.ok) drafted.set(channelId, (drafted.get(channelId) ?? 0) + 1);
      else logger.error('brief refused', { channel: name, slot: slotId, error: r.error });
    };

    const channels = await listChannels(db);
    const killed = new Set<string>();
    for (const ch of channels) {
      const { data: policy } = await db.from('channel_policy').select('kill_switch').eq('channel_id', ch.id).maybeSingle();
      if (policy?.kill_switch) killed.add(ch.id);
    }

    // ── Collect, every tick, whoever is still waiting ──────────────────────
    const { count: waiting } = await db
      .from('llm_batch_requests')
      .select('custom_id', { count: 'exact', head: true })
      .eq('status', 'submitted')
      .like('custom_id', 'brief-%');
    if (waiting) {
      apiKey ??= await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');
      usdInrRate ??= await requireUsdInrRate(db, 'writing the cost rows for 19-draft-briefs');
      const ended = await sweepBatches('brief-', { db, apiKey });
      for (const e of ended) {
        const key = briefBatchKey(e.customId);
        const channelId = e.subject.kind === 'channel' ? e.subject.channelId : null;
        const ch = channels.find((c) => c.id === channelId);
        if (!key || !ch) continue;
        // Reconciled by the sweep either way; only a still-open slot on a live channel gets it.
        if (killed.has(ch.id) || !(await openSlot(key.slotId))) {
          logger.info('collected a draft nobody needs any more', { channel: ch.name, slot: key.slotId, status: e.status });
          continue;
        }
        const out = await draftBriefForSlotBatched(db, key.slotId, key.dayKey, { db, apiKey, usdInrRate, channelId: ch.id });
        if (out.state === 'done') await land(ch.id, ch.name, key.slotId, out.result);
        else if (out.state === 'failed') logger.error('batched draft failed', { channel: ch.name, slot: key.slotId, reason: out.reason });
      }
    }

    // ── Submit, once a day, for slots still open two days out ──────────────
    if (submitting) {
      const today = now.toISOString().slice(0, 10);
      const horizon = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
      // Every channel with a bible in this build, each on its own kill switch and its own slots.
      // A channel without a bible is skipped by name — it has no cast to draft for.
      for (const ch of channels) {
        if (!ch.hasBible) {
          results[ch.name] = { skipped: `no bible folder for slug ${ch.slug ?? '(none)'}` };
          continue;
        }
        if (killed.has(ch.id)) {
          logger.info('kill switch is on; drafting nothing', { channel: ch.name });
          results[ch.name] = { submitted: 0, skipped: 'kill_switch' };
          continue;
        }
        const { data: slots } = await db
          .from('v_slot_status')
          .select('id, slot_date, production_status, kind')
          .eq('channel_id', ch.id)
          .gte('slot_date', today)
          .lte('slot_date', horizon)
          .eq('production_status', 'open');
        const open = (slots ?? []).filter((s) => s.kind === 'short');
        if (open.length === 0) {
          results[ch.name] = { submitted: 0, open: 0 };
          continue;
        }
        apiKey ??= await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');
        usdInrRate ??= await requireUsdInrRate(db, 'writing the cost rows for 19-draft-briefs');

        let submitted = 0;
        for (const slot of open) {
          try {
            // One attempt per slot per day: a retry of this tick must not draft twice.
            const { data: asked } = await db.from('llm_batch_requests').select('status').eq('custom_id', briefBatchCustomId(slot.id!, today)).maybeSingle();
            if (asked) continue;
            const out = await draftBriefForSlotBatched(db, slot.id!, today, { db, apiKey, usdInrRate, channelId: ch.id });
            if (out.state === 'pending') submitted++;
            else if (out.state === 'done') await land(ch.id, ch.name, slot.id!, out.result); // the 3D explainer, drafted synchronously
            else logger.error('batched draft failed', { channel: ch.name, slot: slot.id, reason: out.reason });
          } catch (err) {
            logger.error('drafting failed', { channel: ch.name, slot: slot.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        results[ch.name] = { submitted, open: open.length };
      }
    }

    for (const [channelId, n] of drafted) {
      await notify(db, channelId, 'briefs_pending', `${n} slot${n === 1 ? '' : 's'} within two days had no brief, so Kiln drafted ${n === 1 ? 'one' : 'them'}. Pick a punchline on Approvals.`);
      const ch = channels.find((c) => c.id === channelId);
      if (ch) results[ch.name] = { ...(results[ch.name] as object | undefined), drafted: n };
    }
    return { submitting, ...results };
  },
});
