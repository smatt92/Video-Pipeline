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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import { listMigrations } from './lib/migrations.mjs';
import { describeSqlError, scalar, withClient } from './lib/pg.mjs';

const adminUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('usage: node scripts/check-drift.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const TYPES = 'src/lib/db/types.ts';
const BACKUP = '.types.committed.tmp';
const scratch = `kiln_drift_${process.pid}`;

/** Swap the database name in a Postgres URL, keeping credentials and host. */
function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

let created = false;

async function dropScratch() {
  if (!created) return;
  try {
    await withClient(adminUrl, (admin) =>
      admin.query(`drop database if exists ${scratch} with (force)`),
    );
  } catch {
    console.error(`warning: could not drop scratch database ${scratch}`);
  }
}

function cleanup() {
  if (existsSync(BACKUP)) {
    writeFileSync(TYPES, readFileSync(BACKUP, 'utf8'));
    unlinkSync(BACKUP);
  }
}

// Only the synchronous half can run on 'exit'. Dropping the scratch database needs a
// round trip, so it is awaited in the finally block instead.
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

try {
  if (!existsSync(TYPES)) {
    console.error(`${TYPES} does not exist — nothing to compare against.`);
    process.exit(1);
  }
  writeFileSync(BACKUP, readFileSync(TYPES, 'utf8'));

  await withClient(adminUrl, async (admin) => {
    await admin.query(`drop database if exists ${scratch}`);
    await admin.query(`create database ${scratch}`);
    created = true;
  });

  const scratchUrl = withDatabase(adminUrl, scratch);

  const migrations = listMigrations();

  if (migrations.length === 0) {
    console.error('no migrations found in supabase/migrations/');
    process.exit(1);
  }

  await withClient(scratchUrl, async (client) => {
    for (const m of migrations) {
      const sql = m.sql;
      try {
        await client.query(sql);
        console.log(`  applied ${m.file}`);
      } catch (err) {
        console.error(`\nMigration ${m.file} failed to apply to an empty database:\n`);
        console.error(describeSqlError(err, sql));
        process.exit(1);
      }
    }
  });

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

  const counts = await withClient(scratchUrl, (client) =>
    scalar(
      client,
      "select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') || ' tables, ' || (select count(*) from information_schema.views where table_schema='public') || ' views'",
    ),
  );

  console.log(`\nNO DRIFT — ${migrations.length} migrations, ${counts}.`);
  console.log(`${TYPES} is byte-identical to types regenerated from the migration sequence.`);
  console.log('This says nothing about the hosted project; see the header of this file.');
} finally {
  await dropScratch();
  cleanup();
}
