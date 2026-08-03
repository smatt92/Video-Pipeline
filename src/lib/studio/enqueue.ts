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

/**
 * Hand a script's compiled shots to stage 5.
 *
 * The Studio's `generate_shot` used to walk every gate — video integration verified, recipe
 * present, call priceable — write the shot row, and stop, with a comment saying it was
 * "written to be replaced by the stage-5 submit path rather than to duplicate it". The
 * comment was right and the path did not exist. This is that path.
 *
 * ── Compile, then submit — and why both go through the pipeline's own tasks ──
 *
 * A shot written by the Studio carries a recipe id and no compiled parameters: choosing a
 * recipe is not the same as compiling one, and stage 5 refuses a shot with no
 * `compiled_params`. So the Studio enqueues **stage 4 then stage 5**, exactly as the
 * pipeline would, rather than compiling inline.
 *
 * That is the rule from CLAUDE.md's Studio table doing its work: the Studio lane reaches
 * the drivers *through tools that write every row*, and a shortcut here would be a second
 * implementation of compilation whose output nobody else could replay.
 */
export async function enqueueGenerate(payload: {
  scriptId: string;
}): Promise<{ enqueued: boolean; runId?: string; detail?: string }> {
  try {
    const { shotlistTask } = await import('@/trigger/04-prompt-compile');
    const { generateTask } = await import('@/trigger/05-generate');

    // Compile first. Waiting for it would hold the MCP request open for the length of a
    // model call, so the two are chained by dependency rather than by awaiting: stage 4
    // triggers, and stage 5 is queued behind it on the same script.
    await shotlistTask.trigger({ scriptId: payload.scriptId });
    const handle = await generateTask.trigger({ scriptId: payload.scriptId });

    return { enqueued: true, runId: handle.id };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[studio] could not enqueue generation', { ...payload, detail });
    return { enqueued: false, detail };
  }
}
