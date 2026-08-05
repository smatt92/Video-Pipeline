'use server';

import { revalidatePath } from 'next/cache';

import { serverClient } from '../db/server';

import { recordSnapshot, type SnapshotResult } from './snapshot';

/**
 * The Analytics screen's one write.
 *
 * ── Named as the entry point, because a caller one link deep is not a caller ─
 *
 * CLAUDE.md has three instances of a module whose header claimed a caller and whose caller
 * had none. So, checkably: **the "Record" button in `src/components/measure/snapshot-form.tsx`
 * submits this form action, and that component is rendered by
 * `src/app/(app)/analytics/page.tsx`, which is a route.** The chain ends at a URL a person
 * can open.
 *
 * ── Why a form action and not a Trigger task ─────────────────────────────────
 *
 * Because in Phase 1 the numbers come from a person reading the platform's own dashboard.
 * There is no analytics credential to fetch with — stage 10 has not landed one — so a
 * `11-measure` task would enumerate what is due and then have nothing to call. That is the
 * complete-and-unreachable module this project has now pulled out of the codebase five
 * times, and building it deliberately because a checklist says a stage has a task would be
 * the worst version of it. See `docs/decisions/0008-what-is-unverified.md`.
 */
export async function recordSnapshotAction(formData: FormData): Promise<SnapshotResult> {
  const status = String(formData.get('status') ?? 'measured');

  // Read straight out of the form and hand it to the schema. Deliberately no coercion
  // here: `Number(formData.get('views'))` on an untouched field is `0`, and turning a
  // blank field into a zero is the single failure this whole stage is built around.
  // `SnapshotInputSchema` maps '' to null, once, where it can be seen.
  const common = {
    publicationId: String(formData.get('publicationId') ?? ''),
    ageBucket: String(formData.get('ageBucket') ?? ''),
    metricSource: 'manual_entry' as const,
    enteredBy: null,
  };

  const input =
    status === 'unavailable'
      ? {
          ...common,
          status: 'unavailable' as const,
          unavailableReason: String(formData.get('unavailableReason') ?? ''),
        }
      : {
          ...common,
          status: 'measured' as const,
          views: formData.get('views'),
          likes: formData.get('likes'),
          comments: formData.get('comments'),
          shares: formData.get('shares'),
          saves: formData.get('saves'),
          avgViewPct: formData.get('avgViewPct'),
          retention3sPct: formData.get('retention3sPct'),
        };

  const result = await recordSnapshot(serverClient(), input);
  if (result.ok) revalidatePath('/analytics');
  return result;
}
