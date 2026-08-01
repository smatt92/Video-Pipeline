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
}

export interface CompileInput {
  description: string;
  intent: string;
  durationS: number;
  /** From the closed vocabulary in `kinds.ts`. Null on shots written before it existed. */
  shotKind: string | null;
}

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
 * Then, among the survivors, ordered by:
 *
 *   a. `win_rate` descending, **nulls last**.
 *   b. `version` descending.
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
 * ── Why win_rate ordering degrades rather than waits ─────────────────────────
 *
 * `win_rate` is backfilled from generation outcomes and no generation has ever run, so it
 * is null everywhere. Sorting by it alone is a coin toss wearing a confident interface;
 * refusing to sort until it exists means the library is unusable until it is fully
 * measured. Nulls last, then version, gives a defensible order today that quietly
 * improves into a real ranking as evidence arrives — and never silently prefers an
 * unmeasured recipe to a measured one.
 *
 * ── Ties are reported, not hidden ────────────────────────────────────────────
 *
 * When several recipes fit equally, the note says so. Which one was chosen is arbitrary,
 * and an arbitrary choice that presents as a decision is how a worse recipe quietly wins
 * for a month.
 */
export function compileShot(
  shot: CompileInput,
  library: LibraryPrompt[],
  driver: string,
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

  const candidates = forDriver
    .filter((p) => p.tags.includes(shot.shotKind!))
    // win_rate desc with nulls last, then version desc. See the note above.
    .sort((a, b) => {
      if (a.winRate !== b.winRate) {
        if (a.winRate === null) return 1;
        if (b.winRate === null) return -1;
        return b.winRate - a.winRate;
      }
      return b.version - a.version;
    });

  if (candidates.length === 0) {
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

  const prompt = candidates[0];

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

  const tie = candidates.filter(
    (c) => c.winRate === prompt.winRate && c.version === prompt.version,
  ).length;

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
      `(${prompt.winRate === null ? 'win rate unmeasured' : `win rate ${(prompt.winRate * 100).toFixed(0)}%`})` +
      (tie > 1
        ? `. ${tie} recipes tied on rank — the choice between them is arbitrary until win rates exist.`
        : '.'),
  };
}
