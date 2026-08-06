'use server';

import { revalidatePath } from 'next/cache';

import { tasks } from '@trigger.dev/sdk';

/**
 * The Publish button's Server Action.
 *
 * ── Named as the entry point, checkably ──────────────────────────────────────
 *
 * The **Publish button in `src/components/publish/publish-button.tsx`**, rendered by
 * `src/app/(app)/publish/page.tsx`, which is a route. CLAUDE.md has three instances of a
 * comment naming a caller that was itself uncalled, so this names the URL rather than the
 * function one link up.
 *
 * ── It enqueues; it does not decide ──────────────────────────────────────────
 *
 * Every refusal lives in `publishVideo`, and the DB trigger `enforce_review_pass` is the
 * gate underneath that. Nothing here checks whether the publication is ready, on purpose:
 * a check here would be a fourth place that has an opinion about it, and the three that
 * exist already have to agree.
 *
 * The idempotency key is derived from the publication id rather than generated, so a
 * double-click, a retry and a replay are all the same intent and the unique index turns the
 * second one into a loss rather than a second video on the channel.
 */
export async function publishNowAction(
  publicationId: string,
): Promise<{ enqueued: boolean; runId?: string; error?: string }> {
  try {
    const handle = await tasks.trigger('10-publish', {
      publicationId,
      idempotencyKey: `publish:${publicationId}`,
    });
    revalidatePath('/publish');
    return { enqueued: true, runId: handle.id };
  } catch (err) {
    return { enqueued: false, error: err instanceof Error ? err.message : String(err) };
  }
}
