#!/usr/bin/env node
/**
 * check:guardrails — the guard on the guardrails screen.
 *
 * The Guardrails screen exists so that "is this limit on, and at what number?" is answerable
 * by reading one row instead of by grepping. It spent this whole build answering wrongly:
 * 12 shots against a constraint enforcing 8, and two spend caps naming a submit path that
 * never read them. A wrong guardrail display is worse than an absent one — an absent control
 * is visibly absent, and a wrong number is believed.
 *
 * Three assertions, each one closing a way the register can start lying again:
 *
 *  1. A `kind: 'code'` row must not carry a numeric literal. Its value has to be an imported
 *     identifier, so the displayed number and the enforced number are the same binding
 *     rather than two copies kept in step by discipline.
 *
 *  2. Every `kind: 'none'` row with a probe: that probe must still find nothing under src/.
 *     This is an assertion of *absence*, and it fails at the moment the absence ends —
 *     which is precisely when the row "not enforced" silently becomes false. Without it the
 *     screen under-reports its own coverage for however long nobody looks.
 *
 *  3. No second definition of GUARDRAILS anywhere. Two modules for one concept is worse
 *     than none; the fixture version is deleted and must stay deleted.
 *
 * Static only — no database, no network. Runs in `pnpm check` and in CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = 'src/lib/settings/guardrails.ts';
let failures = 0;

const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
  failures += 1;
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(path);
  }
  return out;
};

const source = readFileSync(REGISTRY, 'utf8');
const files = walk('src');

console.log('guardrail register\n');

// ── 1. code-kind rows must reference a constant, not a literal ──────────────────
//
// Entries are object literals in a readonly array. Split on the key line so each chunk is
// one entry, then look at the kind and value within it.
const entries = source
  .split(/\n {2}\{\n/)
  .slice(1)
  .map((chunk) => chunk.split(/\n {2}\},?\n/)[0]);

if (entries.length < 4) {
  fail(`parsed only ${entries.length} entries out of ${REGISTRY} — the parse is wrong, not the register`);
}

for (const entry of entries) {
  const key = entry.match(/key:\s*'([^']+)'/)?.[1] ?? '(unknown)';
  const kind = entry.match(/kind:\s*'([^']+)'/)?.[1];
  const value = entry.match(/value:\s*([^,\n]+)/)?.[1]?.trim();

  if (kind === 'code') {
    if (!value) fail(`${key}: kind 'code' with no value`);
    else if (/^-?\d/.test(value)) {
      fail(
        `${key}: value is the literal ${value}. A code-enforced guardrail must import the ` +
          `enforcing module's constant, so the screen cannot drift from the enforcer.`,
      );
    } else pass(`${key} — value is ${value}, imported from the enforcing module`);
  }

  if (kind === 'none' && /\bvalue:/.test(entry)) {
    fail(`${key}: kind 'none' carries a value. Not-enforced must never render as a number.`);
  }

  if (kind === 'runtime' && /\bvalue:/.test(entry)) {
    fail(`${key}: kind 'runtime' carries a build-time value. The ceiling is read per run.`);
  }
}

// ── 2. absence probes ───────────────────────────────────────────────────────────
//
// Generated files are excluded. `db/types.ts` and `db/enums.ts` are produced from the schema
// by `pnpm db:types`, so they name every table that exists — including the ones nothing
// reads. A generated type for a table is not a read of it, and counting it as one would make
// every probe on a real table fail from the moment the table was created.
const GENERATED = new Set(['src/lib/db/types.ts', 'src/lib/db/enums.ts']);

const probes = entries
  .map((entry) => ({
    key: entry.match(/key:\s*'([^']+)'/)?.[1] ?? '(unknown)',
    probe: entry.match(/probe:\s*'([^']+)'/)?.[1] ?? null,
  }))
  .filter((p) => p.probe !== null);

for (const { key, probe } of probes) {
  const re = new RegExp(probe);
  const hits = files.filter(
    (f) => f !== REGISTRY && !GENERATED.has(f) && re.test(readFileSync(f, 'utf8')),
  );
  if (hits.length > 0) {
    fail(
      `${key}: declared "not enforced", but /${probe}/ now matches ${hits.length} file(s) — ` +
        `${hits.slice(0, 3).join(', ')}. Somebody wired it; the register still says nobody did.`,
    );
  } else {
    pass(`${key} — /${probe}/ still finds nothing under src/, so "not enforced" is true`);
  }
}

if (probes.length === 0) {
  fail('no absence probes found — assertion 2 is vacuous, which is not the same as passing');
}

// ── 3. one register, not two ────────────────────────────────────────────────────
const duplicates = files.filter(
  (f) => f !== REGISTRY && /export\s+const\s+GUARDRAILS\b/.test(readFileSync(f, 'utf8')),
);
if (duplicates.length > 0) {
  fail(`GUARDRAILS is also defined in ${duplicates.join(', ')}. One concept, one module.`);
} else {
  pass(`GUARDRAILS is defined once, in ${REGISTRY}`);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} failure(s).\n`);
  process.exit(1);
}
console.log('Guardrail register is consistent with what the code enforces.\n');
