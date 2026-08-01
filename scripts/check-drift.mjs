#!/usr/bin/env node
/**
 * Prove that the committed DB types still match the migrations.
 *
 * Builds a scratch database from `supabase/migrations/*.sql` in order, regenerates types
 * from it, and diffs against the committed `src/lib/db/types.ts`. Any difference means
 * someone edited a migration without running `pnpm db:types`, which otherwise surfaces
 * weeks later as a type error in unrelated code.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves, and what it does not
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROVES:      migrations ↔ committed types agree, and the migration sequence applies
 *              cleanly to an empty database in order.
 *
 * DOES NOT:    say anything whatsoever about the hosted Supabase project. It never
 *              connects to it. A hosted database can have drifted arbitrarily — someone
 *              editing a table in the dashboard, a migration applied out of band — and
 *              this check will still pass.
 *
 * For hosted drift you need `supabase db diff --linked`, which requires Docker and
 * network access to the project. This script is the check that can run anywhere, not a
 * substitute for that one.
 *
 * Usage: node scripts/check-drift.mjs [admin-db-url]
 *        (or set DATABASE_URL; needs CREATE DATABASE privilege)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';

const adminUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('usage: node scripts/check-drift.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const TYPES = 'src/lib/db/types.ts';
const BACKUP = '.types.committed.tmp';
const scratch = `kiln_drift_${process.pid}`;

function psql(url, args) {
  return execFileSync('psql', [url, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Swap the database name in a Postgres URL, keeping credentials and host. */
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

let created = false;

function cleanup() {
  if (created) {
    try {
      psql(adminUrl, ['-q', '-c', `drop database if exists ${scratch} with (force)`]);
    } catch {
      console.error(`warning: could not drop scratch database ${scratch}`);
    }
  }
  if (existsSync(BACKUP)) {
    writeFileSync(TYPES, readFileSync(BACKUP, 'utf8'));
    unlinkSync(BACKUP);
  }
}

process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  if (!existsSync(TYPES)) {
    console.error(`${TYPES} does not exist — nothing to compare against.`);
    process.exit(1);
  }
  writeFileSync(BACKUP, readFileSync(TYPES, 'utf8'));

  psql(adminUrl, ['-q', '-c', `drop database if exists ${scratch}`]);
  psql(adminUrl, ['-q', '-c', `create database ${scratch}`]);
  created = true;

  const scratchUrl = withDatabase(adminUrl, scratch);

  const migrations = readdirSync('supabase/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (migrations.length === 0) {
    console.error('no migrations found in supabase/migrations/');
    process.exit(1);
  }

  for (const file of migrations) {
    try {
      psql(scratchUrl, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', `supabase/migrations/${file}`]);
      console.log(`  applied ${file}`);
    } catch (err) {
      console.error(`\nMigration ${file} failed to apply to an empty database:\n`);
      console.error(err.stderr ?? err.message);
      process.exit(1);
    }
  }

  execFileSync('node', ['scripts/gen-types-nodocker.mjs', scratchUrl, 'public'], {
    stdio: ['ignore', 'inherit', 'pipe'],
  });

  const regenerated = readFileSync(TYPES, 'utf8');
  const committed = readFileSync(BACKUP, 'utf8');

  if (regenerated !== committed) {
    // Restore before reporting, so a failed check never leaves a dirty tree.
    writeFileSync(TYPES, committed);
    unlinkSync(BACKUP);

    console.error(`\nDRIFT: ${TYPES} does not match the migrations.`);
    console.error('Run `pnpm db:types` (or `pnpm db:types:nodocker`) and commit the result.\n');

    const a = committed.split('\n');
    const b = regenerated.split('\n');
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 20; i++) {
      if (a[i] !== b[i]) {
        console.error(`  line ${i + 1}`);
        console.error(`    committed:   ${a[i] ?? '(absent)'}`);
        console.error(`    regenerated: ${b[i] ?? '(absent)'}`);
        shown++;
      }
    }
    process.exit(1);
  }

  const counts = psql(scratchUrl, [
    '-tA',
    '-c',
    "select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') || ' tables, ' || (select count(*) from information_schema.views where table_schema='public') || ' views'",
  ]).trim();

  console.log(`\nNO DRIFT — ${migrations.length} migrations, ${counts}.`);
  console.log(`${TYPES} is byte-identical to types regenerated from the migration sequence.`);
  console.log('This says nothing about the hosted project; see the header of this file.');
} finally {
  cleanup();
}
