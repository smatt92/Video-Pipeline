#!/usr/bin/env node
/**
 * Apply migrations over a connection string. No Docker, no Supabase CLI, no psql.
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

import {
  LEDGER_DDL,
  listMigrations,
  maskUrl,
  parseUrl,
  wrap,
} from './lib/migrations.mjs';
import {
  appliedVersions,
  classifyConnectionError,
  describeSqlError,
  recordMigration,
  tryConnect,
} from './lib/pg.mjs';

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

const target = parseUrl(url);
console.log(`\ntarget   ${maskUrl(url)}`);
console.log(`host     ${target.host ?? '?'}:${target.port ?? '?'}  db ${target.database ?? '?'}\n`);

// ── Connect ──────────────────────────────────────────────────────────────────
const attempt = await tryConnect(url);
if (!attempt.ok) {
  const { cause, remedy } = classifyConnectionError(attempt.error, url);
  console.error('Could not connect.\n');
  for (const line of [cause, remedy]) for (const w of wrap(line, 74)) console.error(`  ${w}`);
  console.error(`\n  ${attempt.error.message}\n`);
  console.error('Run `pnpm doctor` for the full picture, or `pnpm db:bundle` to go via the browser.\n');
  process.exit(1);
}

const client = attempt.client;
let exitCode = 0;

try {
  // ── Ledger ─────────────────────────────────────────────────────────────────
  if (!dryRun) {
    try {
      await client.query(LEDGER_DDL);
    } catch (err) {
      console.error(`Could not create the migration ledger:\n  ${err.message}\n`);
      console.error(
        'Every statement in it is `if not exists`, so this failing means the role cannot\n' +
          'create a schema — use the connection string for the `postgres` role.\n',
      );
      process.exit(1);
    }
  }

  const migrations = listMigrations();
  const alreadyApplied = new Set((await appliedVersions(client)) ?? []);

  // ── Baseline ───────────────────────────────────────────────────────────────
  //
  // The escape hatch for a database whose objects exist but whose ledger is empty — SQL
  // run by hand in the editor, most often. Recording those versions without running them
  // is the equivalent of `supabase migration repair --status applied`. It is destructive
  // of the truth if used wrongly, which is why it never happens automatically and names
  // every version explicitly.
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
        // would follow. Without this a dry run lists baselined migrations as "would
        // apply", which is the opposite of what --baseline means.
        alreadyApplied.add(version);
        console.log(`  ~  ${m.file}  would be recorded (dry run)`);
        continue;
      }
      try {
        await recordMigration(client, m);
      } catch (err) {
        console.error(`\nFailed to record ${m.file}:\n  ${err.message}\n`);
        process.exit(1);
      }
      alreadyApplied.add(version);
      console.log(`  +  ${m.file}  recorded as applied`);
    }
    console.log('');
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
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

    const sql = m.sql;
    try {
      // One transaction around the migration and its ledger row. The migration goes in as
      // a single multi-statement query, which Postgres runs over the simple protocol —
      // the same way a file does — so dollar-quoted function bodies need no special
      // handling.
      await client.query('begin');
      await client.query(sql);
      await recordMigration(client, m);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      failure = { migration: m, error: err, sql };
      break;
    }

    applied.push(m);
    console.log(`  +  ${m.file}`);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('');

  if (failure) {
    console.error(`FAILED at ${failure.migration.file}. Nothing from it was applied.\n`);
    for (const line of describeSqlError(failure.error, failure.sql).split('\n')) {
      console.error(`  ${line}`);
    }
    console.error('');

    if (/already exists/i.test(failure.error.message)) {
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
    exitCode = 1;
  } else {
    const verb = dryRun ? 'would apply' : 'applied';
    console.log(`${verb} ${applied.length}, skipped ${skipped.length} already applied.`);

    if (applied.length > 0 && !dryRun) {
      console.log(`\n  ${applied.map((m) => m.version).join(', ')}\n`);
      console.log('Next: `pnpm doctor` to confirm the rows the wizard needs are present.\n');
    } else if (applied.length === 0) {
      console.log('\nThe database is up to date with supabase/migrations/.\n');
    }
  }
} finally {
  await client.end().catch(() => {});
}

process.exit(exitCode);
