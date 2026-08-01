import 'server-only';

import { z } from 'zod';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { fillTemplate } from '../shots/compile';
import { SHOT_KIND_KEYS } from '../shots/kinds';

/**
 * The prompt library — where an exploratory session's findings land.
 *
 * CLAUDE.md: *when an MCP experiment produces a shot recipe that works, persist it to the
 * `prompts` table with `discovered_in='claude-code-mcp'` and the exact params. Production
 * reads the library; it never improvises.*
 *
 * Everything here exists to make that sentence enforceable rather than aspirational. The
 * validation below is the interesting part: a row that looks like a recipe and cannot
 * reproduce the clip it claims to is worse than an empty library, because an empty library
 * is honest and a broken one is trusted.
 */

/** The variables a shot can supply to a template. Anything else is unfillable. */
export const TEMPLATE_VARS = ['description', 'intent', 'duration'] as const;

export const RecipeInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9 _-]*$/i, 'Letters, digits, spaces, hyphens and underscores.'),
  driver: z.string().trim().min(1),
  model: z.string().trim().min(1),
  template: z.string().trim().min(1),
  /**
   * The exact vendor parameters the recipe was proven with, as JSON. Verbatim — not a
   * summary, not defaults.
   *
   * Required and non-empty, enforced here and again by a CHECK constraint in 0010. A
   * recipe saved without the params it was proven with cannot reproduce its own sample,
   * which makes it a plausible-looking guess in a table whose entire purpose is to hold
   * things that are not guesses.
   */
  params: z.string().trim().min(1),
  /** Which shot kinds this serves. The matching key — a recipe with none matches nothing. */
  tags: z.array(z.enum(SHOT_KIND_KEYS as [string, ...string[]])).min(1),
  sampleOutputUrl: z.url().optional().or(z.literal('')),
  discoveredIn: z.enum(['claude-code-mcp', 'manual', 'imported']),
});

export type RecipeInput = z.infer<typeof RecipeInputSchema>;

export interface Recipe {
  id: string;
  name: string;
  driver: string;
  model: string;
  template: string;
  params: Record<string, unknown>;
  tags: string[];
  version: number;
  isActive: boolean;
  retiredAt: string | null;
  retiredReason: string | null;
  discoveredIn: string | null;
  sampleOutputUrl: string | null;
  winRate: number | null;
  createdAt: string;
  /** How many shots have been compiled from it. Why it can never be hard-deleted. */
  shotsUsing: number;
}

export type SaveResult =
  | { ok: true; id: string; name: string; version: number }
  | { ok: false; problems: string[] };

/**
 * Validate a recipe the way it will actually be used.
 *
 * Two checks that a schema cannot express, both of which produce a billed, useless clip if
 * they are skipped:
 *
 *   The params must parse as a JSON object. A string, an array or a number is not a
 *   parameter set, and PostgREST would store it happily.
 *
 *   Every `{{placeholder}}` in the template must be fillable from what a shot carries. An
 *   unresolved placeholder is not a blank — it reaches the vendor verbatim and is billed
 *   as a clip of the literal words "{{subject}}".
 */
export function validateRecipe(input: RecipeInput): { ok: true; params: Record<string, unknown> } | { ok: false; problems: string[] } {
  const problems: string[] = [];

  let params: unknown;
  try {
    params = JSON.parse(input.params);
  } catch (err) {
    return {
      ok: false,
      problems: [`params is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    problems.push('params must be a JSON object — the exact parameter set that was submitted.');
  } else if (Object.keys(params).length === 0) {
    problems.push(
      'params is empty. A recipe without the parameters it was proven with cannot reproduce ' +
        'its own sample, and a library that holds one is worse than an empty one.',
    );
  }

  // Fill with placeholder values purely to discover which keys the template wants.
  const probe = fillTemplate(
    input.template,
    Object.fromEntries(TEMPLATE_VARS.map((v) => [v, `<${v}>`])),
  );

  if (!probe.ok) {
    problems.push(
      `The template uses ${probe.missing.map((m) => `{{${m}}}`).join(', ')}, which a shot ` +
        `does not carry. Available: ${TEMPLATE_VARS.map((v) => `{{${v}}}`).join(', ')}.`,
    );
  }

  if (!/\{\{\s*description\s*\}\}/.test(input.template)) {
    problems.push(
      'The template never uses {{description}}, so every shot compiled from it would send ' +
        'the same prompt regardless of what the shot is. That is one recipe producing one ' +
        'clip, repeatedly.',
    );
  }

  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, params: params as Record<string, unknown> };
}

/**
 * Save a recipe, versioning rather than mutating.
 *
 * A name that already exists gets a new version; the previous one is retired but kept.
 * Editing in place would be wrong twice over: `shots.compiled_params` snapshots what was
 * actually used, and `win_rate` is earned by a specific parameter set. Rewriting the row
 * would leave both describing something that no longer exists.
 */
export async function saveRecipe(db: Db, input: RecipeInput): Promise<SaveResult> {
  const parsed = RecipeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }

  const validated = validateRecipe(parsed.data);
  if (!validated.ok) return { ok: false, problems: validated.problems };

  const { data: existing } = await db
    .from('prompts')
    .select('id, version')
    .eq('name', parsed.data.name)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  const version = (existing?.version ?? 0) + 1;

  const { data, error } = await db
    .from('prompts')
    .insert({
      name: parsed.data.name,
      driver: parsed.data.driver,
      model: parsed.data.model,
      template: parsed.data.template,
      // Already round-tripped through JSON.parse above, so it is jsonb-safe by
      // construction rather than by assertion.
      params: validated.params as Json,
      tags: parsed.data.tags,
      version,
      discovered_in: parsed.data.discoveredIn,
      sample_output_url: parsed.data.sampleOutputUrl || null,
      is_active: true,
      // Left null on purpose. Backfilled from generation success and QA outcomes; no
      // generation has run, and a number here now would be invented.
      win_rate: null,
    })
    .select('id, name, version')
    .single();

  if (error || !data) return { ok: false, problems: [error?.message ?? 'Insert returned nothing.'] };

  // Retire the superseded version rather than deleting it. Shots reference it, and a
  // recipe that produced a clip you shipped is evidence about how that clip was made.
  if (existing) {
    await db
      .from('prompts')
      .update({
        is_active: false,
        retired_at: new Date().toISOString(),
        retired_reason: `Superseded by v${version}.`,
      })
      .eq('id', existing.id);
  }

  return { ok: true, id: data.id, name: data.name, version: data.version };
}

/** Retire a recipe. Never a delete — the FK from `shots` refuses one anyway. */
export async function retireRecipe(db: Db, id: string, reason: string): Promise<void> {
  const { error } = await db
    .from('prompts')
    .update({
      is_active: false,
      retired_at: new Date().toISOString(),
      retired_reason: reason.trim() || 'Retired manually.',
    })
    .eq('id', id);

  if (error) throw new Error(`Retiring the recipe failed: ${error.message}`);
}

export async function reinstateRecipe(db: Db, id: string): Promise<void> {
  const { error } = await db
    .from('prompts')
    .update({ is_active: true, retired_at: null, retired_reason: null })
    .eq('id', id);

  if (error) throw new Error(`Reinstating the recipe failed: ${error.message}`);
}

export async function listRecipes(db: Db): Promise<Recipe[]> {
  const [{ data: rows }, { data: usage }] = await Promise.all([
    db
      .from('prompts')
      .select('id, name, driver, model, template, params, tags, version, is_active, retired_at, retired_reason, discovered_in, sample_output_url, win_rate, created_at')
      .order('name')
      .order('version', { ascending: false }),
    db.from('shots').select('prompt_id').not('prompt_id', 'is', null),
  ]);

  const counts = new Map<string, number>();
  for (const row of usage ?? []) {
    if (row.prompt_id) counts.set(row.prompt_id, (counts.get(row.prompt_id) ?? 0) + 1);
  }

  return (rows ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    driver: p.driver,
    model: p.model,
    template: p.template,
    params:
      p.params && typeof p.params === 'object' && !Array.isArray(p.params)
        ? (p.params as Record<string, unknown>)
        : {},
    tags: p.tags ?? [],
    version: p.version,
    isActive: p.is_active,
    retiredAt: p.retired_at,
    retiredReason: p.retired_reason,
    discoveredIn: p.discovered_in,
    sampleOutputUrl: p.sample_output_url,
    winRate: p.win_rate === null ? null : Number(p.win_rate),
    createdAt: p.created_at,
    shotsUsing: counts.get(p.id) ?? 0,
  }));
}

export interface RecipeGap {
  shotKind: string;
  shotsWaiting: number;
  scriptsBlocked: number;
  secondsWaiting: number;
  activeRecipes: number;
}

export interface UnresolvedShot {
  shotId: string;
  scriptId: string;
  idx: number;
  shotKind: string | null;
  description: string;
  durationS: number;
  compileNote: string | null;
  conceptTitle: string;
  channelName: string;
  matchingRecipes: number;
}

/** The worklist for an exploratory session, ordered by how much is blocked on each kind. */
export async function recipeGaps(db: Db): Promise<RecipeGap[]> {
  const { data } = await db
    .from('v_recipe_gaps')
    .select('shot_kind, shots_waiting, scripts_blocked, seconds_waiting, active_recipes');

  return (data ?? [])
    .filter((r): r is typeof r & { shot_kind: string } => r.shot_kind !== null)
    .map((r) => ({
      shotKind: r.shot_kind,
      shotsWaiting: Number(r.shots_waiting ?? 0),
      scriptsBlocked: Number(r.scripts_blocked ?? 0),
      secondsWaiting: Number(r.seconds_waiting ?? 0),
      activeRecipes: Number(r.active_recipes ?? 0),
    }))
    .sort((a, b) => b.shotsWaiting - a.shotsWaiting);
}

export async function unresolvedShots(db: Db): Promise<UnresolvedShot[]> {
  const { data } = await db
    .from('v_unresolved_shots')
    .select('shot_id, script_id, idx, shot_kind, description, duration_s, compile_note, concept_title, channel_name, matching_recipes');

  return (data ?? []).map((r) => ({
    shotId: r.shot_id ?? '',
    scriptId: r.script_id ?? '',
    idx: r.idx ?? 0,
    shotKind: r.shot_kind,
    description: r.description ?? '',
    durationS: Number(r.duration_s ?? 0),
    compileNote: r.compile_note,
    conceptTitle: r.concept_title ?? '',
    channelName: r.channel_name ?? '',
    matchingRecipes: Number(r.matching_recipes ?? 0),
  }));
}
