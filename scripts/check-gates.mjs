#!/usr/bin/env node
/**
 * Fail if a guard exists and gates nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file exists
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Twice now this project has found a check that looked like it was working and was not.
 * The workflow that failed at dependency install for twenty-five consecutive pushes, so
 * every "CI is green" claim was about a job that never reached a single check (0008 §0).
 * And `test:timings` — a real unit test with real assertions, run by hand once and then
 * never again, because nothing ran it.
 *
 * Both are the same shape: the guard is written, the guard is correct, and the guard is
 * not wired. That is worse than not having it, because its existence is taken as coverage.
 *
 * So this is the guard on the guards. It reads package.json and the CI workflow and
 * insists that every check-shaped script is reachable from `pnpm check`, from CI, or from
 * an explicit exemption below that says why not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The exemption list is the interesting part
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An exemption list rots into a graveyard unless something prunes it, so two rules keep it
 * honest and both are enforced:
 *
 *   An exemption for a script that no longer exists is a failure. Otherwise the list
 *   accumulates names nobody recognises and stops being readable.
 *
 *   An exemption for a script that IS now wired is a failure. Otherwise "we decided not to
 *   run this" outlives the decision, and the next person reads a stale reason as current.
 *
 * Usage: node scripts/check-gates.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

const scripts = pkg.scripts ?? {};

/**
 * What counts as a guard.
 *
 * Prefix-based rather than a hand-kept list, so a newly added `check:whatever` is covered
 * by this the moment it is written rather than the moment somebody remembers to add it
 * here. That is the entire mechanism — a registry you have to remember to update is the
 * thing that failed.
 */
const GUARD_PREFIXES = ['check:', 'test:', 'verify:'];
const ALWAYS_GUARDS = ['typecheck', 'lint'];

const isGuard = (name) =>
  GUARD_PREFIXES.some((p) => name.startsWith(p)) || ALWAYS_GUARDS.includes(name);

/**
 * Guards that deliberately do not gate a push, each with the reason.
 *
 * The bar for being here is narrow: the check cannot run without something a CI runner
 * genuinely does not have. "It is slow" and "it is flaky" are not reasons — they are
 * arguments for fixing the check.
 */
const EXEMPT = [
  {
    script: 'verify:vault',
    why: 'Needs a live Supabase project with the Vault extension. No runner has one, and a stubbed Vault would prove that a stub works.',
  },
  {
    script: 'verify:storage',
    why: 'Needs real S3 credentials against a real bucket. The assemble harness covers the same driver over s3rver in CI; this one exists to test the hosted endpoint.',
  },
  {
    script: 'verify:script',
    why: 'Spends money on a real Messages call. Gating every push on a billed vendor call is a bill, not a guard.',
  },
  {
    script: 'verify:script:direct',
    why: 'The same billed call as verify:script, over a direct Postgres connection instead of PostgREST. Exists for an environment where Supabase is refused at the egress policy and the vendor is not.',
  },
];

// ── What `pnpm check` runs, transitively ────────────────────────────────────
//
// Transitively, because `check` is itself a composition of `pnpm x && pnpm y`, and one of
// those could be a composition too. A single-level scan would call a nested guard
// uncovered and produce exactly the false alarm this file is meant to prevent.
function reachableFrom(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const body = scripts[entry];
  if (!body) return seen;
  for (const [, name] of body.matchAll(/pnpm(?:\s+run)?\s+([\w:-]+)/g)) {
    reachableFrom(name, seen);
  }
  return seen;
}

const inCheck = reachableFrom('check');
inCheck.delete('check');

// ── What CI runs ────────────────────────────────────────────────────────────
//
// Only the `run:` steps, and this is a correction rather than a refinement.
//
// The first version matched `pnpm <name>` anywhere in the file. A comment in the workflow
// read "…reachable from neither `pnpm check` nor this workflow…" — a sentence *about* this
// check — and that sentence was counted as an invocation. Everything reachable from `pnpm
// check` was therefore reported as CI-covered, and `test:tour` passed as "check + ci" while
// CI had no step that ran it.
//
// So the guard on the guards had the exact defect it exists to catch: a coverage claim with
// nothing behind it. Worse than the two in 0008 §0a, because those were guards nobody ran
// and this was a guard *asserting* that guards were run.
//
// The fix is to read only what a shell will execute. Still not a YAML parser — the question
// is narrow enough that a small state machine answers it, and CLAUDE.md says to ask before
// adding a dependency. What matters is that prose can no longer wire anything.
function ciRunLines(yaml) {
  const lines = yaml.split('\n');
  const out = [];
  let blockIndent = null;

  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    // Inside a `run: |` block: everything more-indented belongs to it, and a blank line
    // does not end it.
    if (blockIndent !== null) {
      if (line === '' || indent > blockIndent) {
        out.push(line);
        continue;
      }
      blockIndent = null;
    }

    if (line.startsWith('#')) continue;

    const m = /^(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (!m) continue;

    const value = m[1];
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      blockIndent = indent;
    } else {
      out.push(value);
    }
  }

  // A `#` in a shell line starts a comment there too. Naive, and right for this: the
  // alternative is quote tracking to answer a question no workflow in this repo asks.
  return out.map((l) => l.replace(/\s#.*$/, '')).join('\n');
}

const inCi = new Set();
for (const [, name] of ciRunLines(workflow).matchAll(/pnpm(?:\s+run)?\s+([\w:-]+)/g)) {
  // `pnpm install` and `pnpm dlx` are not scripts. Filtering on what package.json actually
  // defines keeps the set honest and stops a flag or a subcommand looking like a guard.
  if (!scripts[name]) continue;
  for (const reached of reachableFrom(name)) inCi.add(reached);
}

const guards = Object.keys(scripts).filter(isGuard).sort();
const exemptBy = new Map(EXEMPT.map((e) => [e.script, e.why]));

const problems = [];
const rows = [];

for (const guard of guards) {
  const check = inCheck.has(guard);
  const ci = inCi.has(guard);
  const exempt = exemptBy.has(guard);

  if (!check && !ci && !exempt) {
    problems.push(
      `${guard} — runs nowhere. Not reachable from \`pnpm check\`, not invoked by CI, and ` +
        'not in the exemption list. A guard nobody runs is not coverage; it is the ' +
        'appearance of coverage, which is worse. Wire it, or add it to EXEMPT with the ' +
        'reason it cannot be wired.',
    );
  }

  // ── `pnpm check` is a mirror, not an enforcement point ────────────────────
  //
  // Nothing runs `pnpm check` except a person who chooses to. CI enumerates its steps
  // individually, which is better — each one gets a name in the log — but it means
  // membership in `check` gates exactly nothing on a push.
  //
  // This was found immediately after fixing the comment-matching bug above: with prose no
  // longer counted, `test:tour` fell back to `check` alone and still passed, because the
  // original rule accepted either. It had never run in CI. Same defect one level out — a
  // guard whose only home is a command nobody is obliged to run.
  //
  // The reverse is fine and common: verify:ingest and friends are CI-only because they
  // need a database URL a laptop may not have.
  if (check && !ci && !exempt) {
    problems.push(
      `${guard} — in \`pnpm check\` but not in CI. Nothing runs \`pnpm check\` on a push, so ` +
        'this gates nothing: it is the §0a failure with a more reassuring name. Give it a ' +
        'step in .github/workflows/ci.yml, or exempt it with the reason it cannot run there.',
    );
  }

  if (exempt && (check || ci)) {
    problems.push(
      `${guard} — exempt AND wired. The exemption says "${exemptBy.get(guard)}" and that ` +
        'is no longer true. Delete the exemption: a stale reason reads as a current one.',
    );
  }

  rows.push({
    guard,
    where: exempt ? 'exempt' : [check && 'check', ci && 'ci'].filter(Boolean).join(' + '),
  });
}

// ── A script file nobody can invoke by name ─────────────────────────────────
//
// The same failure one level down. `verify-script-draft-direct.mjs` sat in scripts/ for
// days with no package.json entry: written, correct, and reachable only by someone who
// already knew the filename. A guard you have to know about is a guard nobody runs.
const invoked = Object.values(scripts).join(' ');
const orphans = readdirSync('scripts')
  .filter((f) => /^(check|verify|test)-.*\.(mjs|sh)$/.test(f))
  .filter((f) => !invoked.includes(f));

for (const orphan of orphans) {
  problems.push(
    `scripts/${orphan} — no package.json script invokes it. It can only be run by someone ` +
      'who already knows the filename, which is the same problem as an unwired guard with ' +
      'one more step. Give it a name in package.json, then wire or exempt that name.',
  );
}

for (const { script } of EXEMPT) {
  if (!scripts[script]) {
    problems.push(
      `${script} — exempt, but there is no such script in package.json. Either it was ` +
        'renamed and the exemption was not, or it was deleted. Remove the entry.',
    );
  }
}

const width = Math.max(...rows.map((r) => r.guard.length));
console.log('\nGuards, and where each one runs\n');
for (const { guard, where } of rows) {
  console.log(`  ${guard.padEnd(width)}  ${where}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} guard(s) not accounted for:\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  `\nAll ${rows.length} guards are wired or explicitly exempt. ` +
    `${EXEMPT.length} exemption(s), each with a reason.\n`,
);
