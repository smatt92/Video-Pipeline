#!/usr/bin/env node
/**
 * Fail before a deploy if the worker's environment manifest has drifted from the code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The failure this replaces
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Trigger.dev is a second deployment target with its own environment, set in its own
 * dashboard, and nothing in this repo has ever said which variables belong in it. So the
 * list is reconstructed by hand at deploy time, from memory, and the way it goes wrong is
 * not that the deploy fails — it is that the deploy succeeds and the first run dies naming
 * a variable rather than the configuration step that omitted it. `check:trigger-build` next
 * door exists for exactly this shape one layer down, for binaries instead of variables.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two sides, two routes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An assertion is evidence only when its two sides arrive independently.
 *
 *   DERIVED   — walk the import graph from every `src/trigger/*.ts` and collect each
 *               `env.X` and `process.env.X` any reachable module reads. This is what the
 *               code does.
 *   DECLARED  — the `worker-env.ts` fragments, written by a person, saying which variables
 *               the Trigger.dev environment must carry and what breaks without each.
 *
 * The first cannot produce the second: a fragment records *intent* — that a variable with a
 * default must still be set, that one nothing reads is required anyway because the schema
 * validates whole. Comparing them is therefore a real question with a real answer, rather
 * than a producer agreeing with a model of itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves, and what only a deploy can
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROVES: the checklist a person pastes into the dashboard cannot silently lose an entry.
 *         Add `env.NEW_THING` to any of the ~60 modules a task reaches and this fails until
 *         the manifest says what happens without it.
 *
 * DOES NOT: look at the Trigger.dev environment. It has no credentials and should not have
 *           any. `pnpm db:doctor` reports which of the required names are absent *here*, which
 *           is the same question asked of a machine it can actually see.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * And, with VERCEL_ACCESS_TOKEN: does Vercel production carry them? (decision 0017)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Since 0017 the Trigger.dev environment is copied from Vercel production at deploy, so the
 * environment worth asking about is Vercel's. With a token in this shell, every required
 * manifest name and every Bureau credential field must exist in Production, branch-
 * independent, and not Sensitive (the sync cannot read a Sensitive value and skips it in
 * silence). Names and types only: the listing is fetched without `decrypt` and no value is
 * read or printed. The same function refuses the deploy itself (src/lib/trigger/vercel-env.ts).
 *
 * Without a token — CI, which deliberately holds no Vercel credential — that half is
 * SKIPPED and says so by name, as a GitHub notice when running there. Not a pass.
 *
 * Usage: node scripts/check-trigger-env.mjs
 *        VERCEL_ACCESS_TOKEN=… node scripts/check-trigger-env.mjs
 */

import { deriveWorkerEnv, readManifest, NOT_THE_WORKERS } from './lib/worker-env.mjs';

const problems = [];
const notes = [];

const derived = await deriveWorkerEnv();
const declared = await readManifest();

const declaredNames = new Map(declared.map((d) => [d.name, d]));

// ── 1. Reached by the worker, absent from the manifest ──────────────────────
//
// The direction that matters. A variable a task can reach and the checklist does not name
// is one nobody will set, and the run that needs it has already been paid for by then.
for (const [name, files] of derived.vars) {
  if (NOT_THE_WORKERS.has(name)) continue;
  if (declaredNames.has(name)) continue;
  problems.push(
    `${name} is read by code a Trigger task reaches and no worker-env.ts fragment ` +
      `declares it.\n    read in: ${[...files].slice(0, 3).join(', ')}` +
      `${files.size > 3 ? ` (+${files.size - 3} more)` : ''}\n` +
      '    Add it to the manifest with what refuses — or breaks quietly — when it is unset. ' +
      'If nothing does, say so: `required: false` is a claim worth recording, not a gap.',
  );
}

// ── 2. Declared, and nothing reaches it ─────────────────────────────────────
//
// Not automatically wrong — five entries are deliberately here for variables no task reads,
// because `env` is a Proxy that validates the whole schema on any access. That is stated in
// their `refusedBy`. But a *required* entry nothing reaches and nothing explains is a line
// on a checklist telling somebody to configure something for nobody, and those accumulate.
const SCHEMA_REQUIRED_UNREAD = new Set([
  'APP_URL',
  'ALLOWED_EMAIL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
]);

for (const d of declared) {
  if (derived.vars.has(d.name)) continue;
  if (SCHEMA_REQUIRED_UNREAD.has(d.name)) continue;
  if (d.required) {
    problems.push(
      `${d.name} is declared required in ${d.source} and nothing a Trigger task reaches ` +
        'reads it. Either a task stopped reading it, or it belongs on the web deployment ' +
        'rather than this one. A required entry nothing consumes is a configuration step ' +
        'somebody performs for no reason and then trusts.',
    );
  } else {
    notes.push(`${d.name} is declared and unreached — harmless, but it may have outlived its module.`);
  }
}

// ── 3. The schema-required-unread exemptions must stay true ─────────────────
//
// The exemption above exists because `assertEnv()` parses the whole schema on any access.
// If the schema ever makes one of them optional, the exemption is stale and the entry is
// then a required variable nothing needs — the case §2 is for. An exemption that outlives
// its reason is the failure `check:gates` was built for, one directory over.
const envSource = (await import('node:fs')).readFileSync('src/lib/env.ts', 'utf8');
for (const name of SCHEMA_REQUIRED_UNREAD) {
  const field = envSource.match(new RegExp(`^  ${name}:([\\s\\S]*?)(?=^  [A-Z][A-Z0-9_]*:|^\\}\\))`, 'm'));
  if (!field) {
    problems.push(
      `${name} is exempted here as "schema-required but unread", and it is no longer a ` +
        'field of the core schema at all. The exemption has outlived its reason.',
    );
    continue;
  }
  const withoutComments = field[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  if (/\.optional\(\)|\.default\(/.test(withoutComments)) {
    problems.push(
      `${name} is exempted here because the schema makes it non-optional, so a worker that ` +
        'never reads it still needs it. The schema now makes it optional, so that reason is ' +
        'gone and the entry should either find a reader or stop being required.',
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log('\nTrigger.dev environment — pre-deploy check\n');
console.log(`  ${derived.entries.length} tasks reach ${derived.files.size} modules`);
console.log(`  ${derived.vars.size} variables read · ${declared.length} declared\n`);

const required = declared.filter((d) => d.required).map((d) => d.name).sort();
console.log('  Set these in the Trigger.dev environment before deploying:\n');
for (const name of required) console.log(`      ${name}`);

const optional = declared.filter((d) => !d.required).map((d) => d.name).sort();
if (optional.length > 0) {
  console.log('\n  Reachable and not required — see each entry for why:\n');
  for (const name of optional) console.log(`      ${name}`);
}

for (const note of notes) console.log(`\n  note: ${note}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) between the code and the manifest:\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log('\nThe manifest names every variable a Trigger task can reach.');

// ── 4. Vercel production carries them (decision 0017) ───────────────────────
//
// Loaded with Node's own type stripping: both modules have no runtime imports, which is
// what makes that possible, and a load failure is a failure here rather than a skip.
const token = process.env.VERCEL_ACCESS_TOKEN?.trim();
if (!token) {
  const reason =
    'Vercel production was NOT checked: VERCEL_ACCESS_TOKEN is not set here. CI holds no ' +
    'Vercel credential by design, so there this is expected; before a deploy, run ' +
    '`VERCEL_ACCESS_TOKEN=… pnpm check:trigger-env` — the deploy refuses on the same check.';
  console.log(`\n  SKIP  ${reason}\n`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=check:trigger-env skipped the Vercel half::${reason}`);
  process.exit(0);
}

const { listVercelEnv, vercelEnvProblems, VERCEL_PROJECT, VERCEL_TEAM_ID } = await import('../src/lib/trigger/vercel-env-check.ts');
const { workerCredentialFields } = await import('../src/lib/drivers/catalog.ts');

const requiredNames = new Map(required.map((name) => [name, { name, why: 'required by the worker env manifest' }]));
for (const f of workerCredentialFields()) {
  if (!requiredNames.has(f.key)) requiredNames.set(f.key, { name: f.key, aliases: f.aliases, why: `the ${f.slug} credential` });
}

const projectId = process.env.VERCEL_PROJECT_ID?.trim() || VERCEL_PROJECT;
const teamId = process.env.VERCEL_TEAM_ID?.trim() || VERCEL_TEAM_ID;
const listing = await listVercelEnv({ token, projectId, teamId });
if (!listing.ok) {
  console.error(`\n  ✗ Listing ${projectId}'s Vercel variables failed (HTTP ${listing.status ?? 'none'}): ${listing.detail}\n`);
  process.exit(1);
}
const vercelProblems = vercelEnvProblems(listing.entries, [...requiredNames.values()]);
console.log(`\n  Vercel ${projectId} (production): ${listing.entries.length} variables listed, ${requiredNames.size} required\n`);
if (vercelProblems.length > 0) {
  for (const p of vercelProblems) console.error(`  ✗ ${p.detail}`);
  console.error(`\n${vercelProblems.length} required name(s) would not reach the worker. The deploy refuses on the same check.\n`);
  process.exit(1);
}
console.log('  Every required name is in Vercel production, branch-independent and readable by the sync.\n');
