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
