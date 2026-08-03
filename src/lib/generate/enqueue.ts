import 'server-only';

/**
 * Hand the ingest to the worker.
 *
 * Its own module, imported dynamically, for one reason: `confirm.ts` is reached from a
 * Vercel route, and a static import of `src/trigger/` pulls the Trigger SDK and every task
 * it registers into that route's bundle. The route needs to enqueue a job, not to be able
 * to run one.
 *
 * A failure to enqueue must not fail the webhook. The generation is already confirmed and
 * recorded at that point; returning non-2xx would make the vendor redeliver a callback that
 * was handled correctly, and the replay path would then find it already settled and do
 * nothing — so the retry would achieve nothing except noise. The missed ingest is visible
 * instead: a confirmed generation with no `assets` row, which is exactly what the shot grid
 * renders as unfinished.
 */
export async function enqueueIngest(payload: {
  generationId: string;
  assetUrl: string;
}): Promise<{ enqueued: boolean; detail?: string }> {
  try {
    const { ingestTask } = await import('@/trigger/05b-ingest');
    await ingestTask.trigger(payload);
    return { enqueued: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[ingest] could not enqueue', { ...payload, detail });
    return { enqueued: false, detail };
  }
}
