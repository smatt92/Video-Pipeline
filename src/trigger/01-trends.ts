import { logger, schemaTask } from '@trigger.dev/sdk';
import { z } from 'zod';

import { serverClient } from '@/lib/db/server';
import { runTrends, type TrendRunResult } from '@/lib/trends/run';

/**
 * Stage 1 — collect trend signals.
 *
 * A wrapper, like every other stage. Logic in `src/lib/trends/run.ts`.
 *
 * ── The only stage with no credential and no charge ──────────────────────────
 *
 * Public read-only feeds. No `requireCredential`, no `cost_ledger` write, and both absences
 * are deliberate rather than forgotten — see the note in `run.ts`, which says so where a
 * reader auditing rule 5 will look.
 *
 * ── Its caller would be a button, and the button is unbuilt ─────────────────
 *
 * `runTrendsNowAction` invokes this — **and nothing invokes that**, so this task is still
 * unreachable and this paragraph used to claim otherwise. The chain got one link longer and
 * still ends in nothing; see CLAUDE.md on a caller that is itself uncalled. The button is
 * unbuilt. §4 of ARCHITECTURE says stage 1 is cron four times
 * daily and it will be; a schedule is a decision about how often to hit somebody else's
 * public feed, and that decision has not been made. What mattered immediately is that this
 * task had no caller at all, which is the category three other modules were just pulled out
 * of — a stage reachable only from the Trigger dashboard gets reported as built and is not.
 *
 * ── Concurrency 1, and not for the usual reason ──────────────────────────────
 *
 * Every other stage limits concurrency to protect a paid account from a fan-out. This one
 * limits it because two simultaneous runs would race the read-then-write dedup and write
 * the same term twice. A duplicate observation is noise rather than a defect, but noise in
 * the table stage 2 reads from is noise in stage 2's judgement.
 */

const Payload = z.object({
  subreddits: z.array(z.string().min(2).max(40)).max(20).default([]),
});

export const trendsTask = schemaTask({
  id: '01-trends',
  schema: Payload,
  queue: { concurrencyLimit: 1 },

  run: async (payload): Promise<TrendRunResult> => {
    const result = await runTrends(payload, { db: serverClient(), log: logger });

    const failed = result.sources.filter((s) => !s.ok);
    if (failed.length > 0) {
      // Warned, not thrown. Two of the three sources are deliberately unimplemented and one
      // feed being down is not a failed run — but a silent partial collection is how stage 2
      // ends up scoring a week-old picture of the world without anyone noticing.
      logger.warn('some sources returned nothing', { failed });
    }

    return result;
  },
});
