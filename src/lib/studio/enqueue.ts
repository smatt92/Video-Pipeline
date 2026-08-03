import 'server-only';

/**
 * Hand a rough cut to the worker.
 *
 * Same shape and same reason as `src/lib/generate/enqueue.ts`: the dynamic import keeps
 * the Trigger SDK and every registered task out of the bundle of whatever route reaches
 * this. `/api/mcp` needs to be able to *queue* an assembly, not to be able to run one —
 * and it could not run one anyway, because ffmpeg does not exist on the web tier.
 *
 * A failure to enqueue is returned rather than thrown. The tool turns it into a refusal
 * the model can relay, which is more useful to the person in the session than a stack.
 */
export async function enqueueAssemble(payload: {
  scriptId: string;
  variantLabel?: string;
}): Promise<{ enqueued: boolean; runId?: string; detail?: string }> {
  try {
    const { assembleTask } = await import('@/trigger/07-assemble');
    const handle = await assembleTask.trigger(payload);
    return { enqueued: true, runId: handle.id };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[studio] could not enqueue assembly', { ...payload, detail });
    return { enqueued: false, detail };
  }
}
