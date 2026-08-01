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
  /** Null until generations exist. Ordering falls back to version when it is. */
  winRate: number | null;
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
 * Weighting by `win_rate` is not an alternative to this, it is the tier definition. Once
 * win rates exist, the tier is "recipes within `TIER_MARGIN` of the best", and LRU picks
 * inside it — so a measurably worse recipe never gets rotated in for the sake of variety,
 * and equally good ones share the load. Until then every unmeasured recipe is one tier and
 * rotation is pure LRU, which is exactly right for the state of the evidence.
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

  // A character reference that cannot be carried is not a degraded result, it is a
  // different person. Refused rather than dropped.
  const eligible = shot.characterId
    ? byKind.filter((p) => p.acceptsCharacterRef)
    : byKind;

  if (eligible.length === 0) {
    return {
      resolved: false,
      note:
        `This shot carries a character reference and no "${shot.shotKind}" recipe for ` +
        `"${driver}" is marked as carrying one through. ${byKind.length} recipe` +
        `${byKind.length === 1 ? '' : 's'} match the kind but would drop the reference and ` +
        'generate a different-looking person, which is worse than not generating it.',
    };
  }

  // Rank, then take the tier. Nulls rank last and form their own tier, so an unmeasured
  // recipe never displaces a measured one.
  const ranked = [...eligible].sort((a, b) => {
    if (a.winRate !== b.winRate) {
      if (a.winRate === null) return 1;
      if (b.winRate === null) return -1;
      return b.winRate - a.winRate;
    }
    return b.version - a.version;
  });

  const best = ranked[0].winRate;
  const tier =
    best === null
      ? ranked.filter((p) => p.winRate === null)
      : ranked.filter((p) => p.winRate !== null && best - p.winRate <= TIER_MARGIN);

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
      `(${prompt.winRate === null ? 'win rate unmeasured' : `win rate ${(prompt.winRate * 100).toFixed(0)}%`}, ` +
      `used ${prompt.timesCompiled}x). ` +
      (tier.length > 1
        ? `Rotated: ${tier.length} recipes in the top tier, this one least recently used.`
        : `Only recipe in the top tier — this kind has no rotation until a second is discovered.`) +
      (forcedRepeat
        ? ' Repeats the previous shot, because no alternative exists for this kind.'
        : ''),
  };
}
