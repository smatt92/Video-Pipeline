#!/usr/bin/env node
/**
 * Apply migrations over a connection string. No Docker, no Supabase CLI, no new dependency.
 *
 * `supabase db push` does one useful thing this could not do until now: it keeps a record
 * of what has been applied, so a second run is a no-op rather than a pile of "already
 * exists" errors. This writes that record into the same table, in the same shape, so the
 * CLI can take over again the moment it starts working — it will read this history as its
 * own and report the project up to date.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Guarantees
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * IDEMPOTENT     Applied versions are skipped by name. Running twice applies nothing
 *                twice; the second run prints every migration as skipped.
 *
 * ATOMIC         Each migration and its ledger row go in as ONE transaction. Postgres has
 *                transactional DDL, so a migration that fails halfway leaves nothing —
 *                no half-created tables, and no ledger row claiming it succeeded. The two
 *                can never disagree.
 *
 * STOPS          The first failure ends the run. Later migrations assume earlier ones,
 *                so continuing past a failure produces a cascade of errors whose first
 *                line is the only one that matters.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What it does not do
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It cannot reach a database your network cannot reach. If `pnpm doctor` says the
 * connection times out or has no route, this script will fail in exactly the same way the
 * CLI did, and `pnpm db:bundle` — a file you paste into the browser — is the way through.
 *
 * `statements` is stored as the whole file in a single-element array, where the CLI stores
 * one element per parsed statement. Nothing reads that column to decide anything; the
 * deviation is recorded here rather than hidden.
 *
 * Usage: node scripts/db-push.mjs [db-url] [--dry-run] [--baseline <versions>]
 *        (or set DATABASE_URL)
 */

import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEDGER_DDL,
  appliedVersions,
  classifyConnectionError,
  ledgerInsert,
  listMigrations,
  maskUrl,
  parseUrl,
  psql,
  requirePsql,
  wrap,
} from './lib/db.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const baselineIdx = args.indexOf('--baseline');
const baseline =
  baselineIdx === -1
    ? []
    : (args[baselineIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// The index consumed by --baseline, so its value is not mistaken for the connection
// string. -1 here would otherwise mean "index 0", which swallows the URL.
const baselineValueIdx = baselineIdx === -1 ? -1 : baselineIdx + 1;
const url =
  args.find((a, i) => !a.startsWith('--') && i !== baselineValueIdx) ?? process.env.DATABASE_URL;

if (!url) {
  console.error(
    'usage: node scripts/db-push.mjs <db-url> [--dry-run] [--baseline 0001,0002]\n' +
      '       (or set DATABASE_URL, including in .env.local)\n',
  );
  process.exit(2);
}

requirePsql();

const target = parseUrl(url);
console.log(`\ntarget   ${maskUrl(url)}`);
console.log(`host     ${target.host ?? '?'}:${target.port ?? '?'}  db ${target.database ?? '?'}\n`);

// ── Connect ──────────────────────────────────────────────────────────────────
const probe = psql(url, ['-Atqc', 'select 1']);
if (!probe.ok) {
  const { cause, remedy } = classifyConnectionError(probe.stderr, url);
  console.error('Could not connect.\n');
  for (const line of [cause, remedy])
    for (const w of wrap(line, 74)) console.error(`  ${w}`);
  console.error('');
  console.error(`psql said:\n${probe.stderr.trim()}\n`);
  console.error('Run `pnpm doctor` for the full picture, or `pnpm db:bundle` to go via the browser.\n');
  process.exit(1);
}

// ── Ledger ───────────────────────────────────────────────────────────────────
if (!dryRun) {
  const ledger = psql(url, ['-v', 'ON_ERROR_STOP=1', '-q'], { input: LEDGER_DDL });
  if (!ledger.ok) {
    console.error(`Could not create the migration ledger:\n${ledger.stderr.trim()}\n`);
    console.error(
      'Every statement in it is `if not exists`, so this failing means the role cannot\n' +
        'create a schema — use the connection string for the `postgres` role.\n',
    );
    process.exit(1);
  }
}

const migrations = listMigrations();
const alreadyApplied = new Set(appliedVersions(url) ?? []);

// ── Baseline ─────────────────────────────────────────────────────────────────
//
// The escape hatch for a database whose objects exist but whose ledger is empty — SQL run
// by hand in the editor, most often. Recording those versions without running them is the
// equivalent of `supabase migration repair --status applied`. It is destructive of the
// truth if used wrongly, which is why it never happens automatically and names every
// version explicitly.
if (baseline.length > 0) {
  const known = new Set(migrations.map((m) => m.version));
  const unknown = baseline.filter((v) => !known.has(v));
  if (unknown.length > 0) {
    console.error(`No migration file for version(s): ${unknown.join(', ')}\n`);
    process.exit(2);
  }

  console.log(`Baselining ${baseline.length} migration(s) — recorded as applied, NOT run:\n`);
  for (const version of baseline) {
    const m = migrations.find((x) => x.version === version);
    if (alreadyApplied.has(version)) {
      console.log(`  =  ${m.file}  already recorded`);
      continue;
    }
    if (dryRun) {
      // Marked applied in memory too, so the plan printed below is the plan a real run
      // would follow. Without this a dry run lists baselined migrations as "would apply",
      // which is the opposite of what --baseline means.
      alreadyApplied.add(version);
      console.log(`  ~  ${m.file}  would be recorded (dry run)`);
      continue;
    }
    const r = psql(url, ['-v', 'ON_ERROR_STOP=1', '-q'], { input: ledgerInsert(m) });
    if (!r.ok) {
      console.error(`\nFailed to record ${m.file}:\n${r.stderr.trim()}\n`);
      process.exit(1);
    }
    alreadyApplied.add(version);
    console.log(`  +  ${m.file}  recorded as applied`);
  }
  console.log('');
}

// ── Apply ────────────────────────────────────────────────────────────────────
const applied = [];
const skipped = [];
let failure = null;

for (const m of migrations) {
  if (alreadyApplied.has(m.version)) {
    skipped.push(m);
    console.log(`  =  ${m.file}`);
    continue;
  }

  if (dryRun) {
    applied.push(m);
    console.log(`  ~  ${m.file}  would apply (dry run)`);
    continue;
  }

  // Migration and ledger row in one file, run with --single-transaction: they commit
  // together or not at all. A temp file rather than stdin so psql reports real line
  // numbers against the migration's own text.
  const tmp = join(tmpdir(), `kiln-${m.version}-${process.pid}.sql`);
  writeFileSync(tmp, `${m.sql}\n\n${ledgerInsert(m)}\n`);

  const r = psql(url, ['-v', 'ON_ERROR_STOP=1', '--single-transaction', '-q', '-f', tmp], {
    timeoutSeconds: 30,
  });

  try {
    unlinkSync(tmp);
  } catch {
    /* the temp file outliving the run is not worth failing over */
  }

  if (!r.ok) {
    failure = { migration: m, stderr: r.stderr.trim() };
    break;
  }

  applied.push(m);
  console.log(`  +  ${m.file}`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log('');

if (failure) {
  console.error(`FAILED at ${failure.migration.file}. Nothing from it was applied.\n`);
  console.error(`${failure.stderr}\n`);

  if (/already exists/i.test(failure.stderr)) {
    console.error(
      'That object exists but this migration is not in the ledger, which means the schema\n' +
        'was changed outside this history — SQL pasted into the editor, usually.\n\n' +
        'If you are certain the database already contains everything up to and including\n' +
        `${failure.migration.version}, record it without running it:\n\n` +
        `  pnpm db:push --baseline ${failure.migration.version}\n\n` +
        'Confirm with `pnpm doctor` first. Baselining a migration that did not actually run\n' +
        'leaves a database that claims to be somewhere it is not.\n',
    );
  }

  console.error(
    `Applied before the failure: ${applied.length}. Each one is committed and recorded, so\n` +
      'fixing the cause and re-running picks up exactly where this stopped.\n',
  );
  process.exit(1);
}

const verb = dryRun ? 'would apply' : 'applied';
console.log(`${verb} ${applied.length}, skipped ${skipped.length} already applied.`);

if (applied.length > 0 && !dryRun) {
  console.log(`\n  ${applied.map((m) => m.version).join(', ')}\n`);
  console.log('Next: `pnpm doctor` to confirm the rows the wizard needs are present.\n');
} else if (applied.length === 0) {
  console.log('\nThe database is up to date with supabase/migrations/.\n');
}
