/**
 * Turning a described shot into an exact driver payload.
 *
 * ── This never improvises, and that is the whole design ──────────────────────
 *
 * CLAUDE.md: *when an MCP experiment produces a shot recipe that works, persist it to the
 * `prompts` table with `discovered_in='claude-code-mcp'` and the exact params. Production
 * reads the library; it never improvises.*
 *
 * So this function does not generate parameters. It **selects** a library entry and fills
 * its template. If the library has nothing for a shot, the honest output is "no recipe
 * yet", recorded on the shot as `compile_note`, and stage 5 will not submit it. The
 * alternative — inventing a plausible motion name and aspect ratio — costs real credits to
 * discover was wrong, and a clip that generates and is unusable is more expensive than one
 * that was never submitted.
 *
 * That is why the empty-library case below is a normal return rather than an error. On a
 * fresh install the library *is* empty, every shot comes back unresolved, and the next
 * action is an exploratory session — not a bug report.
 */

import { CHARACTER_REF_IS_PASSED, CHARACTER_REF_UNSUPPORTED } from '../generate/character-ref';

export interface LibraryPrompt {
  id: string;
  name: string;
  driver: string;
  model: string;
  template: string;
  params: Record<string, unknown>;
  /** Which shot kinds this recipe serves. The matching key. */
  tags: string[];
  version: number;
  isActive: boolean;
  /**
   * Editorial survival: shots that reached a passed review ÷ shots compiled, 0–1.
   *
   * Was `winRate` until migration 0034. The rename is not cosmetic — see `rankBasis` in
   * `compileShot` for what the old name was hiding once outcomes existed.
   */
  shipRate: number | null;
  /**
   * What the videos this recipe appeared in actually did: median 3s retention at 7d,
   * rescaled to 0–1 to match `shipRate`. Null until a video carrying this recipe has been
   * measured, which is months after the recipe first ships.
   */
  retentionScore: number | null;
  /** Exposure. Rises on every compile, good clip or not. */
  timesCompiled: number;
  /** Drives least-recently-used rotation within a rank tier. */
  lastCompiledAt: string | null;
  /** Proven to carry a character reference through to the output. */
  acceptsCharacterRef: boolean;
}

export interface CompileInput {
  description: string;
  intent: string;
  durationS: number;
  /** From the closed vocabulary in `kinds.ts`. Null on shots written before it existed. */
  shotKind: string | null;
  /** Set when a recurring character must appear. Requires a recipe that carries the ref. */
  characterId?: string | null;
}

/**
 * Recipes already chosen for other shots in the same script, in order.
 *
 * Passed in rather than read from the database because the decision is per-script and the
 * rows do not exist yet — stage 4 compiles the whole shotlist before writing any of it.
 */
export type ScriptSoFar = readonly string[];

export type CompileOutcome =
  | {
      resolved: true;
      promptId: string;
      compiledParams: Record<string, unknown>;
      note: string;
    }
  | { resolved: false; note: string };

/**
 * Fill `{{placeholders}}` from a flat record.
 *
 * An unresolved placeholder is a failure, not a blank. A template that renders
 * `a cinematic shot of {{subject}}` with the braces intact reaches the vendor verbatim and
 * produces a clip of the literal words, billed in full.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
): { ok: true; text: string } | { ok: false; missing: string[] } {
  const missing: string[] = [];

  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined || value === '') {
      missing.push(key);
      return '';
    }
    return value;
  });

  return missing.length > 0 ? { ok: false, missing: [...new Set(missing)] } : { ok: true, text };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MATCHING RULE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A recipe fits a shot when all three hold:
 *
 *   1. `prompts.driver` equals the configured video driver.
 *   2. `prompts.is_active` is true.
 *   3. `shots.shot_kind` appears in `prompts.tags`.
 *
 *   4. If the shot has a `character_id`, the recipe must accept a character reference.
 *      A recipe that does not carries no way to keep the person consistent, and silently
 *      dropping the reference generates a stranger — which destroys the one asset that
 *      compounds (Addendum 04 §3).
 *
 * Then selection, which is **not** simply "take the best one".
 *
 * ── Why tags, and why a closed vocabulary ────────────────────────────────────
 *
 * The alternative was matching the shot's free-text description against the recipe's
 * template — semantic similarity, embeddings, or asking a model. All of them are a guess
 * dressed as a lookup, and the cost of guessing wrong is a generated clip that is billed
 * and unusable. A recipe either declares it serves close-on-an-object frames or it does
 * not; that is a fact someone established by watching a clip, and facts are what should
 * decide how money gets spent.
 *
 * The vocabulary is closed because an open one stops matching within a month. "product
 * macro", "macro product" and "close product" are three tags and one idea, and a lookup
 * across them silently returns nothing — the worst failure available here, because it
 * reads as "no recipe yet" rather than as "your tags disagree".
 *
 * ── Rotation: tier by rank, then least-recently-used ────────────────────────
 *
 * Taking the top-ranked recipe every time is what produced the problem this section
 * exists for: one recipe compiled three of seven shots on the first real shotlist, and
 * would have kept doing that on every script forever. `structure_hash` protects script
 * variety and nothing protected visual variety — and repeated identical camera moves are
 * more legible to a policy reviewer than beat structure is, because a reviewer watches
 * rather than diffs.
 *
 * So: rank the candidates, keep everything within the top tier, and pick the
 * **least recently compiled** member of that tier.
 *
 * Least-recently-used rather than random, for three reasons.
 *
 *   Random can repeat by chance. LRU cannot: it guarantees the spread that random only
 *   makes likely, which matters when the thing being spread is a compliance signal.
 *
 *   Random is unreproducible. Stage 4 must be replayable from stage 3's output
 *   (CLAUDE.md), and "replay produced different vendor parameters" makes a cost
 *   investigation impossible. LRU is a pure function of stored state, so a replay against
 *   the same state gives the same answer, and against a grown library gives a *better* one
 *   — which is the correct behaviour rather than a compromise.
 *
 *   Random cannot be explained. `compile_note` says which recipe was chosen and why; "the
 *   dice said so" is not a reason anyone can act on when a clip comes back wrong.
 *
 * Weighting by a performance figure is not an alternative to this, it is the tier
 * definition. Once figures exist, the tier is "recipes within `TIER_MARGIN` of the best",
 * and LRU picks inside it — so a measurably worse recipe never gets rotated in for the sake
 * of variety, and equally good ones share the load. Until then every unmeasured recipe is
 * one tier and rotation is pure LRU, which is exactly right for the state of the evidence.
 *
 * *Which* figure is `rankBasis`, below, and it is chosen once for the whole eligible set
 * rather than per recipe. Migration 0034 gave recipes a second kind of evidence — what the
 * videos they appeared in actually retained — on a scale that means something different
 * from the first.
 *
 * ── And never twice in a row within one script ───────────────────────────────
 *
 * A hard constraint on top of the ordering, not a preference. Three slow push-ins in a
 * thirty-second video is visible to a viewer, not just to a policy reviewer, and the tier
 * ordering alone would allow it whenever one recipe is genuinely the least-recently-used
 * twice running. If an alternative exists the previous shot's recipe is excluded outright;
 * if none exists it is used again and the note says so, because refusing to compile a shot
 * over an aesthetic preference would be worse than repeating a camera.
 * ── Ties are reported, not hidden ────────────────────────────────────────────
 *
 * When several recipes fit equally, the note says so. Which one was chosen is arbitrary,
 * and an arbitrary choice that presents as a decision is how a worse recipe quietly wins
 * for a month.
 */
/**
 * How close to the best a recipe must rank to stay in the rotation tier.
 *
 * Only meaningful once win rates exist. Five points: a recipe landing 60% of the time is
 * not meaningfully worse than one landing 62%, and excluding it concentrates every shot of
 * that kind onto one camera for a difference inside the noise of a small sample.
 */
const TIER_MARGIN = 0.05;

/**
 * How a recipe's rank was justified, for `compile_note`.
 *
 * Always says which of the two numbers it is. A note reading "72%" is unreadable a month
 * later, because 72% of shots surviving review and a 72nd-percentile retention are
 * different facts about different things, and the note is the only record of which one
 * stage 4 acted on.
 */
function describeScore(p: LibraryPrompt, basis: 'retention' | 'ship'): string {
  if (basis === 'retention') {
    return p.retentionScore === null
      ? 'retention unmeasured'
      : `3s retention ${(p.retentionScore * 100).toFixed(0)}%`;
  }
  return p.shipRate === null
    ? 'never shipped, so unranked'
    : `ship rate ${(p.shipRate * 100).toFixed(0)}%`;
}

export function compileShot(
  shot: CompileInput,
  library: LibraryPrompt[],
  driver: string,
  /** Recipes already chosen for earlier shots in this script, in order. */
  scriptSoFar: ScriptSoFar = [],
): CompileOutcome {
  if (library.length === 0) {
    return {
      resolved: false,
      note:
        'The prompt library is empty. Shot recipes are discovered in an exploratory ' +
        "session against the vendor's MCP surface and persisted to the prompts table with " +
        "discovered_in='claude-code-mcp'; production reads that library and never " +
        'improvises. Nothing to select from yet.',
    };
  }

  if (!shot.shotKind) {
    return {
      resolved: false,
      note:
        'This shot has no shot_kind, so nothing can be matched to it. Shots written before ' +
        'the library existed carry none — re-running stage 4 for this script assigns one. ' +
        'A kind is not guessed from the description, because a wrong guess is a billed clip.',
    };
  }

  const forDriver = library.filter((p) => p.isActive && p.driver === driver);

  if (forDriver.length === 0) {
    return {
      resolved: false,
      note:
        `No active recipe for driver "${driver}". The library holds ${library.length} ` +
        `entr${library.length === 1 ? 'y' : 'ies'}, none of them active for this driver.`,
    };
  }

  const byKind = forDriver.filter((p) => p.tags.includes(shot.shotKind!));

  if (byKind.length === 0) {
    const kindsAvailable = [...new Set(forDriver.flatMap((p) => p.tags))].sort();
    return {
      resolved: false,
      note:
        `No recipe tagged "${shot.shotKind}" for driver "${driver}". ` +
        (kindsAvailable.length
          ? `The library serves: ${kindsAvailable.join(', ')}.`
          : 'No active recipe carries any shot-kind tag.'),
    };
  }

  // ── A character reference, and a guard that permitted what it forbade ──────
  //
  // This filtered to recipes marked `accepts_character_ref` and refused when none matched,
  // saying the others "would drop the reference and generate a different-looking person".
  // The accepting branch dropped it too — the compiled parameters below have never carried
  // a reference field, and nothing in src/ reads the `characters` table.
  //
  // `submit.ts` had the identical guard with the identical hole, found first. Fixing that
  // one left this one still claiming a protection it did not provide, which is why the
  // reason now lives in one module both call: two guards drifted into the same wrong shape
  // independently, and half a fix reads exactly like a whole one.
  if (shot.characterId && !CHARACTER_REF_IS_PASSED) {
    return { resolved: false, note: CHARACTER_REF_UNSUPPORTED };
  }

  const eligible = byKind;

  // ── Which evidence this decision is drawn on ───────────────────────────────
  //
  // Two numbers now say a recipe is good, and they are not the same claim. `shipRate` is
  // editorial survival — a human passed the render this shot was in. `retentionScore` is
  // what viewers did. Once outcomes exist they will disagree, and that is the point of
  // measuring: a shot that survives review and loses the audience is exactly the case the
  // loop is meant to find.
  //
  // So the basis is chosen for the WHOLE eligible set, never per recipe. Ranking a
  // shipRate of 0.80 against a retentionScore of 0.35 compares unrelated quantities and
  // picks the larger one, and the comparison looks perfectly ordinary in the sort. This is
  // why migration 0034 refused to put a `selection_score` column on
  // `v_recipe_performance` and left the decision here: a per-row view cannot see the set,
  // so it cannot make this choice, and a column that looked authoritative would have made
  // the cross-scale comparison invisible instead of impossible.
  //
  // Retention wins only when EVERY eligible recipe has it. One unmeasured recipe and the
  // whole kind ranks on ship rate — which is the conservative direction: it delays acting
  // on outcomes rather than acting on a mixture.
  const rankBasis: 'retention' | 'ship' =
    eligible.length > 0 && eligible.every((p) => p.retentionScore !== null) ? 'retention' : 'ship';

  const scoreOf = (p: LibraryPrompt) =>
    rankBasis === 'retention' ? p.retentionScore : p.shipRate;

  // Rank, then take the tier. Nulls rank last and form their own tier, so an unmeasured
  // recipe never displaces a measured one.
  const ranked = [...eligible].sort((a, b) => {
    const as = scoreOf(a);
    const bs = scoreOf(b);
    if (as !== bs) {
      if (as === null) return 1;
      if (bs === null) return -1;
      return bs - as;
    }
    return b.version - a.version;
  });

  const best = scoreOf(ranked[0]);
  const tier =
    best === null
      ? ranked.filter((p) => scoreOf(p) === null)
      : ranked.filter((p) => {
          const s = scoreOf(p);
          return s !== null && best - s <= TIER_MARGIN;
        });

  // Never the same camera twice running inside one script, if there is any alternative.
  const previous = scriptSoFar[scriptSoFar.length - 1];
  const withoutRepeat = tier.filter((p) => p.id !== previous);
  const rotatable = withoutRepeat.length > 0 ? withoutRepeat : tier;
  const forcedRepeat = withoutRepeat.length === 0 && tier.length > 0 && previous !== undefined
    && tier.some((p) => p.id === previous);

  // Least recently compiled first. Never-compiled sorts earliest, so a new recipe is used
  // before an established one — which is what makes a freshly discovered recipe actually
  // enter circulation rather than sitting behind whichever one is already ahead.
  const prompt = [...rotatable].sort((a, b) => {
    const at = a.lastCompiledAt ?? '';
    const bt = b.lastCompiledAt ?? '';
    if (at !== bt) return at < bt ? -1 : 1;
    return a.timesCompiled - b.timesCompiled;
  })[0];

  const filled = fillTemplate(prompt.template, {
    description: shot.description,
    intent: shot.intent,
    duration: String(shot.durationS),
  });

  if (!filled.ok) {
    return {
      resolved: false,
      note:
        `Library prompt "${prompt.name}" v${prompt.version} needs ${filled.missing.join(', ')}, ` +
        'which this shot does not carry. An unfilled placeholder would reach the vendor ' +
        'verbatim and be billed as a clip of the literal words.',
    };
  }

  return {
    resolved: true,
    promptId: prompt.id,
    // The exact payload the driver will be handed. Stored so a generation can be explained
    // and replayed later without re-deriving it from a template that may have moved on.
    compiledParams: {
      ...prompt.params,
      shot_kind: shot.shotKind,
      prompt: filled.text,
      model: prompt.model,
      duration_s: shot.durationS,
      prompt_name: prompt.name,
      prompt_version: prompt.version,
    },
    note:
      `Compiled from "${prompt.name}" v${prompt.version} ` +
      // Names the basis as well as the figure. "72%" alone reads as one quantity across
      // every note in the table while silently being two, which is the collision migration
      // 0034 renamed a column to end — it would be reintroduced here in prose.
      `(${describeScore(prompt, rankBasis)}, ` +
      `used ${prompt.timesCompiled}x). ` +
      (tier.length > 1
        ? `Rotated: ${tier.length} recipes in the top tier, this one least recently used.`
        : `Only recipe in the top tier — this kind has no rotation until a second is discovered.`) +
      (forcedRepeat
        ? ' Repeats the previous shot, because no alternative exists for this kind.'
        : ''),
  };
}
