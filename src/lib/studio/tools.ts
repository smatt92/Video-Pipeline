import 'server-only';

import { z } from 'zod';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { primaryForKind } from '../drivers/catalog';
import { usability } from '../integrations/verify';
import { listRecipes, RecipeInputSchema, saveRecipe } from '../prompts/library';
import { SHOT_KIND_KEYS } from '../shots/kinds';
import { materialiseScript } from './materialise';

/**
 * The six Studio tools, as implementations.
 *
 * This module is the only place they exist. `src/app/api/mcp/route.ts` exposes them over
 * the MCP protocol so Opus 5 can reach them through the `mcp_servers` connector, and
 * `scripts/verify-studio.mjs` drives the same objects over a local bridge. Both paths run
 * *these* functions; neither reimplements one.
 *
 * That matters more here than usual. The connector is a server-side fetch made from
 * Anthropic's infrastructure to a public URL, so the leg from Anthropic to this app cannot
 * be exercised from a container that is not publicly reachable. Everything on this side of
 * that leg can be, and is — but only because there is one copy of it.
 *
 * ── A refusal is a result, not an error ──────────────────────────────────────
 *
 * `generate_shot` on a fresh install refuses: the library is empty and the video
 * integration has never verified. That is the correct answer, and it is returned as data —
 * `{ refused: true, blockers: [...] }` — rather than raised. Three reasons:
 *
 *   The model has to relay it. "I can't generate this yet because X and Y" is the useful
 *   turn; an exception becomes "the tool failed", which is both less true and less useful.
 *
 *   All the blockers, not the first. Refusing on missing credentials and then, one round
 *   trip later, on the empty library wastes a paid turn to deliver half an answer.
 *
 *   An error would be indistinguishable from the tool being broken, which is the exact
 *   confusion this project keeps engineering away from.
 *
 * ── Every tool is session-scoped ─────────────────────────────────────────────
 *
 * The session id comes from the bearer token, never from an argument. A tool argument is
 * model-controlled, and a model that can name the session it is writing to can write to
 * somebody else's — including its script, its shots and its cost.
 */

export interface ToolContext {
  db: Db;
  sessionId: string;
  /** Set from the session row. Tools that would spend money check it before they do. */
  spendCapInr: number | null;
}

/** What a tool hands back. JSON, because it is going into a model's context as text. */
export type ToolResult =
  | { ok: true; [k: string]: unknown }
  | {
      ok: false;
      refused: true;
      /** One line for the model to relay. */
      summary: string;
      /** Every gate that is closed, not just the first one hit. */
      blockers: { code: string; detail: string; remedy: string }[];
    };

export interface StudioTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** JSON Schema, served verbatim by `tools/list` and by the Anthropic tool declaration. */
  readonly inputSchema: Record<string, unknown>;
  readonly args: z.ZodType;
  run(ctx: ToolContext, args: unknown): Promise<ToolResult>;
}

function refuse(summary: string, blockers: { code: string; detail: string; remedy: string }[]): ToolResult {
  return { ok: false, refused: true, summary, blockers };
}

// ═════════════════════════════════════════════════════════════════════════════
// list_prompt_recipes
// ═════════════════════════════════════════════════════════════════════════════

const ListRecipesArgs = z.object({
  tag: z.enum(SHOT_KIND_KEYS as [string, ...string[]]).optional(),
  include_retired: z.boolean().default(false),
});

const listPromptRecipes: StudioTool = {
  name: 'list_prompt_recipes',
  title: 'List prompt recipes',
  description:
    'List the shot recipes in the prompt library. A recipe is a proven template plus the ' +
    'exact vendor parameters it was proven with. Production never improvises: a shot can ' +
    'only be generated from a recipe that is already in this library. Call this before ' +
    'generate_shot to see what is available, and save_prompt_recipe to add one.',
  inputSchema: {
    type: 'object',
    properties: {
      tag: {
        type: 'string',
        enum: SHOT_KIND_KEYS,
        description: 'Only recipes serving this shot kind.',
      },
      include_retired: {
        type: 'boolean',
        description: 'Include recipes that have been retired. Default false.',
      },
    },
    additionalProperties: false,
  },
  args: ListRecipesArgs,

  async run(ctx, raw) {
    const args = ListRecipesArgs.parse(raw);
    const all = await listRecipes(ctx.db);

    const recipes = all
      .filter((r) => (args.include_retired ? true : r.isActive))
      .filter((r) => (args.tag ? r.tags.includes(args.tag) : true));

    return {
      ok: true,
      count: recipes.length,
      // Said explicitly rather than left to be inferred from a zero. An empty list is a
      // state with a cause and a next action, and the model is better at relaying that
      // than at deducing it.
      note:
        recipes.length === 0
          ? 'The library is empty. Nothing can be generated until a recipe exists, and a ' +
            'recipe is only worth saving once its parameters have actually produced a clip ' +
            'you watched — explore against the vendor\u2019s own hosted MCP server in Claude ' +
            'Code, then save the exact params here with save_prompt_recipe.'
          : undefined,
      recipes: recipes.map((r) => ({
        id: r.id,
        name: r.name,
        driver: r.driver,
        model: r.model,
        template: r.template,
        params: r.params,
        tags: r.tags,
        version: r.version,
        accepts_character_ref: r.acceptsCharacterRef,
        times_compiled: r.timesCompiled,
        times_shipped: r.timesShipped,
        discovered_in: r.discoveredIn,
      })),
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// save_prompt_recipe
// ═════════════════════════════════════════════════════════════════════════════

const SaveRecipeArgs = z.object({
  name: z.string(),
  driver: z.string(),
  model: z.string(),
  template: z.string(),
  params: z.string(),
  tags: z.array(z.string()).min(1),
  sample_output_url: z.string().optional(),
  accepts_character_ref: z.boolean().default(false),
});

const savePromptRecipe: StudioTool = {
  name: 'save_prompt_recipe',
  title: 'Save a prompt recipe',
  description:
    'Persist a shot recipe to the library. Only save a recipe whose parameters produced a ' +
    'clip that was actually watched and judged good — the library is the set of things ' +
    'that are not guesses. `params` is the exact vendor payload as a JSON object string, ' +
    'verbatim, not a summary and not defaults. Every {{placeholder}} in the template must ' +
    'be fillable from what a shot carries: description, intent, duration.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short identifying name, letters and digits.' },
      driver: { type: 'string', description: 'Vendor slug the recipe belongs to.' },
      model: { type: 'string', description: 'Vendor model the params were proven against.' },
      template: {
        type: 'string',
        description: 'Prompt template. Placeholders: {{description}}, {{intent}}, {{duration}}.',
      },
      params: {
        type: 'string',
        description: 'The exact vendor parameters as a JSON object, serialised to a string.',
      },
      tags: {
        type: 'array',
        items: { type: 'string', enum: SHOT_KIND_KEYS },
        minItems: 1,
        description: 'Which shot kinds this recipe serves. A recipe with none matches nothing.',
      },
      sample_output_url: {
        type: 'string',
        description: 'URL of the clip this recipe was proven with.',
      },
      accepts_character_ref: {
        type: 'boolean',
        description:
          'Only true if you watched a clip from these params and the character reference ' +
          'came through as the right person.',
      },
    },
    required: ['name', 'driver', 'model', 'template', 'params', 'tags'],
    additionalProperties: false,
  },
  args: SaveRecipeArgs,

  async run(ctx, raw) {
    const args = SaveRecipeArgs.parse(raw);

    // Re-validated through the library's own schema rather than trusted from here. The
    // model is an external caller like any other, and `RecipeInputSchema` is the boundary.
    const parsed = RecipeInputSchema.safeParse({
      name: args.name,
      driver: args.driver,
      model: args.model,
      template: args.template,
      params: args.params,
      tags: args.tags,
      sampleOutputUrl: args.sample_output_url ?? '',
      discoveredIn: 'claude-code-mcp',
      acceptsCharacterRef: args.accepts_character_ref,
    });

    if (!parsed.success) {
      return refuse('That recipe is not well-formed and was not saved.', [
        {
          code: 'schema',
          detail: parsed.error.issues
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; '),
          remedy: 'Fix the named fields and call save_prompt_recipe again.',
        },
      ]);
    }

    const result = await saveRecipe(ctx.db, parsed.data);

    if (!result.ok) {
      return refuse('That recipe was rejected by the library.', [
        {
          code: 'invalid_recipe',
          detail: result.problems.join('; '),
          remedy:
            'A recipe that cannot reproduce its own sample is worse than no recipe. Fix ' +
            'the problems listed and save again.',
        },
      ]);
    }

    return {
      ok: true,
      id: result.id,
      name: result.name,
      version: result.version,
      note: `Saved as "${result.name}" v${result.version}, discovered_in='claude-code-mcp'.`,
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// generate_shot
// ═════════════════════════════════════════════════════════════════════════════

const GenerateShotArgs = z.object({
  description: z.string().min(4),
  duration_s: z.number().positive().max(30),
  intent: z.string().optional(),
  recipe_id: z.string().optional(),
  /** Only meaningful once a script exists; the first call materialises one. */
  idx: z.number().int().min(0).optional(),
  /** Carried onto the materialised script when this is the first generation. */
  title: z.string().optional(),
  angle: z.string().optional(),
  vo_text: z.string().optional(),
});

const generateShot: StudioTool = {
  name: 'generate_shot',
  title: 'Generate a shot',
  description:
    'Generate one video shot from a library recipe. This spends money. The first call in ' +
    'a session materialises a script row, so the shot and everything after it — review, ' +
    'rough cut, cost — is ordinary pipeline data rather than a Studio-only artifact. ' +
    'Refuses, with every reason listed, when the video integration has never verified, ' +
    'when no library recipe matches, or when the call cannot be priced.',
  inputSchema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'What is on screen, in one sentence.' },
      duration_s: { type: 'number', description: 'Shot length in seconds.' },
      intent: { type: 'string', description: 'What this shot is doing editorially.' },
      recipe_id: {
        type: 'string',
        description: 'The library recipe to use. Omit to let the shot kind choose.',
      },
      idx: { type: 'integer', description: 'Position in the script. Appends when omitted.' },
      title: { type: 'string', description: 'Working title. Used when the script is created.' },
      angle: { type: 'string', description: 'The editorial point of view. Used at creation.' },
      vo_text: { type: 'string', description: 'Voiceover text so far. Used at creation.' },
    },
    required: ['description', 'duration_s'],
    additionalProperties: false,
  },
  args: GenerateShotArgs,

  async run(ctx, raw) {
    const args = GenerateShotArgs.parse(raw);
    const blockers: { code: string; detail: string; remedy: string }[] = [];

    // ── Gate 1: is there a video vendor we are allowed to call? ──────────────
    const descriptor = primaryForKind('video');
    if (!descriptor) {
      blockers.push({
        code: 'no_video_integration',
        detail: 'No integration in the catalogue is marked primary for video.',
        remedy: 'Fix INTEGRATION_CATALOG in src/lib/drivers/catalog.ts.',
      });
    } else {
      const use = await usability(ctx.db, descriptor.slug);
      if (!use.usable) {
        blockers.push({
          code: use.deferred ? 'video_integration_deferred' : 'video_integration_unusable',
          detail: use.reason,
          remedy:
            'Settings → Integrations, then Test connection. Enabling states intent; ' +
            'verifying states fact, and only the second one lets a task spend money.',
        });
      }
    }

    // ── Gate 2: is there a recipe? ───────────────────────────────────────────
    const recipes = (await listRecipes(ctx.db)).filter((r) => r.isActive);
    const chosen = args.recipe_id
      ? recipes.find((r) => r.id === args.recipe_id)
      : recipes[0];

    if (recipes.length === 0) {
      blockers.push({
        code: 'empty_prompt_library',
        detail:
          'The prompt library has no active recipes, so there is no proven parameter set ' +
          'to generate from.',
        remedy:
          'Explore against the vendor\u2019s own hosted MCP server in Claude Code until a ' +
          'recipe produces a clip worth keeping, then save it here with save_prompt_recipe. ' +
          'Production reads the library; it never improvises.',
      });
    } else if (!chosen) {
      blockers.push({
        code: 'unknown_recipe',
        detail: `No active recipe with id ${args.recipe_id}.`,
        remedy: 'Call list_prompt_recipes and pick one of the ids it returns.',
      });
    }

    // ── Gate 3: can it be priced? ────────────────────────────────────────────
    //
    // Checked even when the gates above are already closed, because the answer is part of
    // the same picture: a verified credential and a full library still cannot generate
    // anything while the credit rate is a placeholder, and finding that out one refusal
    // later is one more paid turn.
    if (descriptor && chosen) {
      const { currentRate } = await import('../cost/rate-card');
      const rate = await currentRate(ctx.db, {
        driver: chosen.driver,
        model: chosen.model,
        endpoint: null,
        unit: 'credit',
      });
      if (!rate.found) {
        blockers.push({
          code: 'unpriced',
          detail: rate.detail,
          remedy:
            'Settings → Rate card. A credit rate is verified by watching the balance move, ' +
            'not by reading a docs page — nobody publishes these.',
        });
      }
    }

    if (blockers.length > 0) {
      return refuse(
        `Cannot generate this shot yet — ${blockers.length} thing${blockers.length === 1 ? '' : 's'} ` +
          'must be true first, and none of them is a failure of this request.',
        blockers,
      );
    }

    // Past every gate: materialise the script if this is the first generation, then hand
    // the shot to the pipeline. Nothing below is reachable on a fresh install, and it is
    // written to be replaced by the stage-5 submit path rather than to duplicate it.
    const script = await materialiseScript(ctx.db, ctx.sessionId, {
      title: args.title,
      angle: args.angle,
      voText: args.vo_text,
    });

    if (!script.ok) {
      return refuse('The session could not materialise a script to hang this shot on.', [
        { code: script.code, detail: script.detail, remedy: script.remedy },
      ]);
    }

    const { data: existing } = await ctx.db
      .from('shots')
      .select('idx')
      .eq('script_id', script.scriptId)
      .order('idx', { ascending: false })
      .limit(1);

    const idx = args.idx ?? ((existing?.[0]?.idx ?? -1) + 1);

    const { data: shot, error } = await ctx.db
      .from('shots')
      .insert({
        script_id: script.scriptId,
        idx,
        duration_s: args.duration_s,
        description: args.description,
        prompt_id: chosen!.id,
        compiled_params: { ...chosen!.params, model: chosen!.model } as Json,
        compiled_at: new Date().toISOString(),
        status: 'pending',
      })
      .select('id, idx')
      .single();

    if (error) {
      return refuse('The shot row was refused by the database.', [
        { code: 'shot_insert_failed', detail: error.message, remedy: 'Check pnpm doctor.' },
      ]);
    }

    return {
      ok: true,
      script_id: script.scriptId,
      script_created: script.created,
      shot_id: shot.id,
      idx: shot.idx,
      status: 'pending',
      note:
        'The shot row exists and is compiled. Submission to the vendor happens in stage 5, ' +
        'which is driven by the pipeline lane — this tool does not call the vendor directly, ' +
        'so the idempotency key and the cost row are written in exactly one place.',
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// check_generation
// ═════════════════════════════════════════════════════════════════════════════

const CheckGenerationArgs = z.object({ generation_id: z.string().min(1) });

const checkGeneration: StudioTool = {
  name: 'check_generation',
  title: 'Check a generation',
  description:
    'Read the current state of one generation: status, error, whether its asset has been ' +
    'ingested and normalised. Reads rows — it does not poll the vendor, because completion ' +
    'arrives by webhook and a poll would be a second, less reliable source of the same fact.',
  inputSchema: {
    type: 'object',
    properties: { generation_id: { type: 'string' } },
    required: ['generation_id'],
    additionalProperties: false,
  },
  args: CheckGenerationArgs,

  async run(ctx, raw) {
    const args = CheckGenerationArgs.parse(raw);

    const { data: generation } = await ctx.db
      .from('generations')
      // One string literal, not a concatenation. PostgREST's generated types resolve the
      // row shape from the *literal* select, and `'a' + 'b'` widens to `string` — which
      // turns every field access below into an error about GenericStringError.
      .select('id, shot_id, kind, driver, model, status, attempt, error_code, error_detail, confirmed_at, submitted_at, completed_at, studio_session_id, origin')
      .eq('id', args.generation_id)
      .maybeSingle();

    if (!generation) {
      return refuse(`No generation ${args.generation_id}.`, [
        {
          code: 'unknown_generation',
          detail: 'No row with that id.',
          remedy: 'Call list_session_shots for the ids this session actually created.',
        },
      ]);
    }

    // Scoped to the session for the same reason the session id is not an argument. A
    // readable id from another session is still another session's data.
    if (generation.studio_session_id && generation.studio_session_id !== ctx.sessionId) {
      return refuse('That generation belongs to a different session.', [
        {
          code: 'out_of_session',
          detail: 'Studio tools are scoped to the session that authenticated them.',
          remedy: 'Open that session to inspect its generations.',
        },
      ]);
    }

    const { data: asset } = await ctx.db
      .from('assets')
      .select('id, storage_key, duration_s, normalized_at, created_at')
      .eq('generation_id', generation.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      ok: true,
      generation: {
        id: generation.id,
        shot_id: generation.shot_id,
        kind: generation.kind,
        driver: generation.driver,
        model: generation.model,
        status: generation.status,
        attempt: generation.attempt,
        error_code: generation.error_code,
        error_detail: generation.error_detail,
        confirmed: generation.confirmed_at !== null,
        submitted_at: generation.submitted_at,
        completed_at: generation.completed_at,
      },
      asset: asset
        ? {
            id: asset.id,
            duration_s: asset.duration_s === null ? null : Number(asset.duration_s),
            // The distinction the rough cut depends on. A non-normalised asset concatenates
            // into a file that plays and is wrong.
            normalised: asset.normalized_at !== null,
          }
        : null,
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// list_session_shots
// ═════════════════════════════════════════════════════════════════════════════

const ListSessionShotsArgs = z.object({});

const listSessionShots: StudioTool = {
  name: 'list_session_shots',
  title: 'List this session’s shots',
  description:
    'List the shots this session has created, in order, with their generation status and ' +
    'whether a normalised asset exists. Returns an empty list before the first ' +
    'generate_shot — the session has not materialised a script yet.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  args: ListSessionShotsArgs,

  async run(ctx) {
    const { data: session } = await ctx.db
      .from('studio_sessions')
      .select('script_id')
      .eq('id', ctx.sessionId)
      .maybeSingle();

    if (!session?.script_id) {
      return {
        ok: true,
        script_id: null,
        count: 0,
        shots: [],
        note:
          'This session has not materialised a script yet. It does that on the first ' +
          'successful generate_shot, so there is nothing to list rather than something ' +
          'missing.',
      };
    }

    const { data: shots } = await ctx.db
      .from('shots')
      .select('id, idx, description, duration_s, duration_source, status, prompt_id')
      .eq('script_id', session.script_id)
      .order('idx');

    const ids = (shots ?? []).map((s) => s.id);
    const { data: generations } = ids.length
      ? await ctx.db
          .from('generations')
          .select('id, shot_id, status, error_code')
          .in('shot_id', ids)
      : { data: [] };

    const byShot = new Map<string, { id: string; status: string; error_code: string | null }[]>();
    for (const g of generations ?? []) {
      if (!g.shot_id) continue;
      const list = byShot.get(g.shot_id) ?? [];
      list.push({ id: g.id, status: g.status, error_code: g.error_code });
      byShot.set(g.shot_id, list);
    }

    return {
      ok: true,
      script_id: session.script_id,
      count: shots?.length ?? 0,
      shots: (shots ?? []).map((s) => ({
        id: s.id,
        idx: s.idx,
        description: s.description,
        duration_s: Number(s.duration_s),
        duration_source: s.duration_source,
        status: s.status,
        generations: byShot.get(s.id) ?? [],
      })),
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// stitch_rough_cut
// ═════════════════════════════════════════════════════════════════════════════

const StitchArgs = z.object({
  variant_label: z.string().max(40).optional(),
});

const stitchRoughCut: StudioTool = {
  name: 'stitch_rough_cut',
  title: 'Stitch a rough cut',
  description:
    'Concatenate this session’s normalised shots into one rough cut for review. ' +
    'Hands the work to the worker rather than doing it here: ffmpeg does not run on the ' +
    'web tier. Returns immediately with the queued job; the render appears on the review ' +
    'screen when it finishes.',
  inputSchema: {
    type: 'object',
    properties: {
      variant_label: { type: 'string', description: 'Label for this cut. Default "rough".' },
    },
    additionalProperties: false,
  },
  args: StitchArgs,

  async run(ctx, raw) {
    const args = StitchArgs.parse(raw);

    const { data: session } = await ctx.db
      .from('studio_sessions')
      .select('script_id')
      .eq('id', ctx.sessionId)
      .maybeSingle();

    if (!session?.script_id) {
      return refuse('There is nothing to stitch yet.', [
        {
          code: 'no_script',
          detail: 'This session has not materialised a script, so it has no shots.',
          remedy: 'Generate at least one shot first.',
        },
      ]);
    }

    const { data: shots } = await ctx.db
      .from('shots')
      .select('id, idx')
      .eq('script_id', session.script_id)
      .order('idx');

    if (!shots || shots.length === 0) {
      return refuse('There is nothing to stitch yet.', [
        {
          code: 'no_shots',
          detail: 'The script exists but has no shots.',
          remedy: 'Generate at least one shot first.',
        },
      ]);
    }

    const { enqueueAssemble } = await import('./enqueue');
    const queued = await enqueueAssemble({
      scriptId: session.script_id,
      variantLabel: args.variant_label ?? 'rough',
    });

    if (!queued.enqueued) {
      return refuse('The stitch could not be queued.', [
        {
          code: 'enqueue_failed',
          detail: queued.detail ?? 'The worker did not accept the job.',
          remedy:
            'Check that the Trigger.dev deployment is live — see docs/decisions/0010-trigger-deploy.md.',
        },
      ]);
    }

    return {
      ok: true,
      script_id: session.script_id,
      shots: shots.length,
      queued: true,
      note:
        'Queued. The task refuses any shot that is not normalised to the canonical ' +
        'intermediate, and asserts the finished duration against the sum of the shots — a ' +
        'cut whose length disagrees with its rows is recorded as a failed render, not as a ' +
        'render with a note.',
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════

export const STUDIO_TOOLS: readonly StudioTool[] = [
  listPromptRecipes,
  savePromptRecipe,
  generateShot,
  checkGeneration,
  listSessionShots,
  stitchRoughCut,
];

export function toolByName(name: string): StudioTool | undefined {
  return STUDIO_TOOLS.find((t) => t.name === name);
}

/** The `tools/list` payload, and the shape the Anthropic tool declaration reuses. */
export function toolDescriptors() {
  return STUDIO_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}
