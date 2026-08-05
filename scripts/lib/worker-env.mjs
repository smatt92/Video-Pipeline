/**
 * The worker's environment, derived from the code and read from the manifest.
 *
 * Two readers share this: `check:trigger-env` (which compares the two sides and fails on
 * drift) and `pnpm db:doctor` (which reports which of the required variables are absent
 * *here*). It lives in `scripts/lib/` for the same reason `catalog.mjs` does — a shared
 * source the harnesses can read without a compile step, since `pnpm check` runs this
 * before `pnpm typecheck` and has no compiled output to import.
 */

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Every file that contributes manifest entries.
 *
 * A convention rather than a list: any `worker-env.ts` under `src/lib/` is a manifest
 * fragment. That is what lets the vendor and storage halves live in the directories rule 1
 * confines them to and still be seen here, and it means a third fragment is picked up by
 * existing without anybody remembering to register it.
 */
export const MANIFEST_GLOB = 'src/lib/**/worker-env.ts';

/**
 * Every environment variable reachable from a Trigger task, by walking imports.
 *
 * Derived rather than listed. A hand-maintained "what the worker needs" is a list somebody
 * has to remember to update, which is the failure mode one level up — and the ffmpeg check
 * next door already learned that lesson the expensive way, so the shape is borrowed.
 *
 * Returns `{ vars: Map<name, Set<file>>, files: Set<file>, entries: string[] }`.
 */
export async function deriveWorkerEnv(root = process.cwd()) {
  const entries = (await readdir(join(root, 'src/trigger')))
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => join('src/trigger', f))
    .sort();

  const seen = new Set();
  const vars = new Map();

  const record = (name, file) => {
    if (!vars.has(name)) vars.set(name, new Set());
    vars.get(name).add(file);
  };

  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);

    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      return;
    }

    // Comments are stripped before scanning, and the first change made after this file was
    // written is why: a comment saying "a hand-rolled `if (!env.X) throw`" registered `X`
    // as a variable the worker needs. `check:vendors` deliberately reads comments — a
    // comment naming a vendor is a leak of the same kind as code doing it — but a comment
    // *describing* an env access is not an env access, and a checklist with a phantom
    // entry on it teaches people to skim the checklist.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Three routes to a variable, and all three must be seen or the manifest under-reports.
    //   `env.FOO`          — the Proxy in src/lib/env.ts, the normal route
    //   `process.env.FOO`  — the deliberate bypasses (Edge cannot see through a Proxy)
    //   `requireEnv('FOO')` — optional at boot, required at this call site
    //
    // The third was added the moment the first caller of `requireEnv` appeared, which was
    // also the moment `WEBHOOK_CALLBACK_BASE_URL` vanished from the derived set while
    // remaining just as required. A deriver that sees one syntax for a thing with three is
    // the silent-under-report failure, and it fails safe here only by luck: the manifest
    // still declared it, so the check flagged the disagreement instead of losing it.
    for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)) record(m[1], rel);
    for (const m of code.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g)) record(m[1], rel);
    for (const m of code.matchAll(/\brequireEnv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) record(m[1], rel);

    // Imports are read from the stripped copy too, so a commented-out import is not walked.
    for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const target = resolveImport(root, rel, m[1]);
      if (target) walk(target);
    }
  };

  for (const e of entries) walk(e);

  return { vars, files: seen, entries };
}

/** `@/x` and relative paths only. A bare package name is not our code and is not walked. */
function resolveImport(root, fromRel, spec) {
  let base;
  if (spec.startsWith('@/')) base = join('src', spec.slice(2));
  else if (spec.startsWith('.')) base = join(dirname(fromRel), spec);
  else return null;

  base = base.replace(/\.js$/, '');

  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(resolve(root, candidate))) return candidate;
  }
  return null;
}

/**
 * The declared manifest, parsed out of the TypeScript module.
 *
 * Read as text rather than imported: `pnpm check` runs before `pnpm typecheck`, and the
 * manifest module imports `Env` from `src/lib/env.ts`, which reads `process.env` through a
 * Proxy at first access. The question here is only what is declared.
 *
 * Throws rather than returning an empty list when the shape is unrecognised. A parser that
 * silently matches nothing reports "no requirements" and passes — a green check proving the
 * opposite of what it claims, which is precisely the bug the ffmpeg check shipped with.
 */
export async function readManifest(root = process.cwd()) {
  const fragments = await findManifestFragments(join(root, 'src/lib'), root);

  if (fragments.length === 0) {
    throw new Error(
      `No manifest fragments found matching ${MANIFEST_GLOB}. Either the convention changed ` +
        'or this walker is looking in the wrong place — and an empty manifest would ' +
        'otherwise report that the worker needs nothing and pass.',
    );
  }

  const declared = [];
  const seen = new Map();

  for (const rel of fragments) {
    const text = readFileSync(join(root, rel), 'utf8');
    let found = 0;

    for (const m of text.matchAll(
      /\{\s*name:\s*'([A-Z][A-Z0-9_]*)'\s*,\s*\n?\s*required:\s*(true|false)\s*,/g,
    )) {
      found += 1;
      const name = m[1];
      // A name in two fragments is two claims about one variable, and they can disagree
      // about whether it is required. Name collisions are defects, not conveniences.
      if (seen.has(name)) {
        throw new Error(
          `${name} is declared in both ${seen.get(name)} and ${rel}. One variable, two ` +
            'claims about whether the worker needs it — and nothing decides which wins.',
        );
      }
      seen.set(name, rel);
      declared.push({ name, required: m[2] === 'true', source: rel });
    }

    if (found === 0) {
      throw new Error(
        `${rel} is a manifest fragment by its name and no entries parsed out of it. Each ` +
          'entry must be `{ name: \'X\', required: true|false, refusedBy: … }`.',
      );
    }
  }

  return declared;
}

async function findManifestFragments(dir, root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findManifestFragments(path, root)));
    else if (entry.name === 'worker-env.ts') out.push(path.slice(root.length + 1));
  }
  return out.sort();
}

/**
 * Variables the worker reaches that are not its to supply.
 *
 * `KILN_BUILD_*` and `VERCEL_*` are stamped by the build; `NEXT_RUNTIME` is set by Next.
 * They appear in the derived set because a shared module reads them, and they are never
 * something to paste into the Trigger.dev dashboard.
 */
export const NOT_THE_WORKERS = new Set([
  'KILN_BUILD_SHA',
  'KILN_BUILD_AT',
  'NEXT_RUNTIME',
  'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_REF',
  'NODE_ENV',
]);
