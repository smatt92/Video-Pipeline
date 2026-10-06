/**
 * Does Vercel production carry every variable the worker needs, in a form the sync can read?
 *
 * Shared by two callers that ask the same question at different times:
 *
 *   `vercelEnv()` in vercel-env.ts   at deploy, before the build — refuses the deploy.
 *   `scripts/check-trigger-env.mjs`  on `pnpm check` / CI when VERCEL_ACCESS_TOKEN is set.
 *
 * No runtime imports, on purpose: the check script loads this file with Node's own type
 * stripping, which cannot follow the extensionless relative imports the rest of `src/` uses.
 * Everything it needs arrives as an argument.
 *
 * ── Names and types, never values ────────────────────────────────────────────
 *
 * The listing is requested without `decrypt`, and every function here reads `key`, `type`
 * and `target` only. An encrypted value comes back as ciphertext, which is still not
 * something to print — so `listVercelEnv` drops it before returning.
 *
 * ── Why "sensitive" is a failure, not a detail ───────────────────────────────
 *
 * Read from the extension's source (`@trigger.dev/build` 4.5.9,
 * `extensions/core/vercelSyncEnvVars.js`): it lists with `decrypt=true` and then
 * `if (!value) return false` — a variable without a readable value is skipped, silently.
 * Vercel never returns a value for a variable of type `sensitive`, and the Vercel CLI makes
 * new production variables sensitive by default (`vercel env add … --no-sensitive` is the
 * documented opt-out). So the likeliest state of a personal project is: every secret
 * present by name, none of them syncable, and a deploy that reports success. That is the
 * case this exists to name.
 */

/** The Vercel project the worker's environment is read from. Not secrets: identifiers. */
export const VERCEL_PROJECT = 'video-pipeline';
/**
 * Team `sahilmatt-6245s-projects`. The id rather than the slug because the extension passes
 * `teamId` and nothing else; read from Vercel's own 403 body for that scope on 06-Oct-2026.
 */
export const VERCEL_TEAM_ID = 'team_2UHmmkh8jSZXWBQg8dIICYP5';
export const VERCEL_TARGET = 'production';

export interface VercelEnvEntry {
  key: string;
  type: string;
  targets: string[];
  gitBranch: string | null;
}

export type VercelListing =
  | { ok: true; entries: VercelEnvEntry[] }
  | { ok: false; status: number | null; detail: string };

/**
 * The same endpoint and parameters the extension calls, minus `decrypt` — so what this sees
 * is what the sync will see, by name.
 */
export async function listVercelEnv(input: {
  token: string;
  projectId?: string;
  teamId?: string;
  fetchImpl?: typeof fetch;
}): Promise<VercelListing> {
  const params = new URLSearchParams({ target: VERCEL_TARGET });
  params.set('teamId', input.teamId ?? VERCEL_TEAM_ID);
  const url = `https://api.vercel.com/v8/projects/${encodeURIComponent(input.projectId ?? VERCEL_PROJECT)}/env?${params}`;
  let res: Response;
  try {
    res = await (input.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${input.token}` } });
  } catch (err) {
    return { ok: false, status: null, detail: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    // The body names the scope problem when there is one ("re-authenticate to this scope"),
    // and never carries a value. Truncated anyway.
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: text.slice(0, 300) };
  }
  const body: unknown = await res.json().catch(() => null);
  const envs = body && typeof body === 'object' && Array.isArray((body as { envs?: unknown }).envs)
    ? ((body as { envs: unknown[] }).envs)
    : null;
  if (!envs) return { ok: false, status: res.status, detail: 'The listing carried no envs array.' };

  const entries: VercelEnvEntry[] = [];
  for (const e of envs) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.key !== 'string') continue;
    const target = r.target;
    entries.push({
      key: r.key,
      type: typeof r.type === 'string' ? r.type : 'unknown',
      targets: Array.isArray(target) ? target.filter((t): t is string => typeof t === 'string')
        : typeof target === 'string' ? [target] : [],
      gitBranch: typeof r.gitBranch === 'string' ? r.gitBranch : null,
    });
  }
  return { ok: true, entries };
}

export interface RequiredName {
  name: string;
  /** Other names the worker accepts for the same value (catalogue `envAliases`). */
  aliases?: readonly string[];
  /** Where the requirement comes from, for the message. */
  why: string;
}

export interface EnvProblem {
  name: string;
  kind: 'absent' | 'sensitive' | 'branch_only';
  detail: string;
}

/**
 * Every required name must exist in production, branch-independent, with a type the
 * extension can read (`encrypted` or `plain`). One problem per name, naming the fix.
 */
export function vercelEnvProblems(entries: readonly VercelEnvEntry[], required: readonly RequiredName[]): EnvProblem[] {
  const prod = entries.filter((e) => e.targets.includes(VERCEL_TARGET));
  const problems: EnvProblem[] = [];
  for (const r of required) {
    const names = [r.name, ...(r.aliases ?? [])];
    const found = prod.filter((e) => names.includes(e.key));
    if (found.length === 0) {
      problems.push({
        name: r.name,
        kind: 'absent',
        detail: `${r.name} is not set for Production in Vercel (${r.why}).`,
      });
      continue;
    }
    if (found.every((e) => e.gitBranch !== null)) {
      problems.push({
        name: r.name,
        kind: 'branch_only',
        detail: `${r.name} exists in Vercel Production only for a git branch; the sync reads the branch-independent value.`,
      });
      continue;
    }
    const usable = found.filter((e) => e.gitBranch === null && e.type !== 'sensitive');
    if (usable.length === 0) {
      problems.push({
        name: r.name,
        kind: 'sensitive',
        detail:
          `${r.name} is a Sensitive variable in Vercel. Its value cannot be read back by anything, ` +
          'including the sync, which skips it without a word. Re-add it with Sensitive off: ' +
          `\`vercel env rm ${r.name} production\` then \`vercel env add ${r.name} production --no-sensitive\`.`,
      });
    }
  }
  return problems;
}
