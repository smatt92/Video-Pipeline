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
  tags: string[];
  version: number;
}

export interface CompileInput {
  description: string;
  intent: string;
  durationS: number;
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
 * Pick the library entry for a shot.
 *
 * Deliberately dumb for now: the first entry for the configured driver, preferring the
 * highest version. Ranking by `win_rate` is the obvious next step and is not done yet
 * because `win_rate` is backfilled from generation success and QA outcomes, and no
 * generation has ever run — a ranking over an all-null column is a coin toss with a
 * confident interface.
 */
export function compileShot(
  shot: CompileInput,
  library: LibraryPrompt[],
  driver: string,
): CompileOutcome {
  const candidates = library
    .filter((p) => p.driver === driver)
    .sort((a, b) => b.version - a.version);

  if (candidates.length === 0) {
    return {
      resolved: false,
      note:
        library.length === 0
          ? `The prompt library is empty. Shot recipes are discovered in an exploratory ` +
            `session against the vendor's MCP surface and persisted to the prompts table ` +
            `with discovered_in='claude-code-mcp'; production reads that library and never ` +
            `improvises. Nothing to select from yet.`
          : `No library prompt for driver "${driver}" — the library holds ${library.length} ` +
            `entr${library.length === 1 ? 'y' : 'ies'} for other drivers.`,
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

  return {
    resolved: true,
    promptId: prompt.id,
    // The exact payload the driver will be handed. Stored so a generation can be explained
    // and replayed later without re-deriving it from a template that may have moved on.
    compiledParams: {
      ...prompt.params,
      prompt: filled.text,
      model: prompt.model,
      duration_s: shot.durationS,
      prompt_name: prompt.name,
      prompt_version: prompt.version,
    },
    note: `Compiled from "${prompt.name}" v${prompt.version}.`,
  };
}
