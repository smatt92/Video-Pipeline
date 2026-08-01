#!/usr/bin/env node
/**
 * Prove that every integration in the catalogue has a row on a freshly *pushed* database.
 *
 * The check exists because of a specific failure: four of five catalogue integrations
 * lived only in `supabase/seed.sql`, `supabase db push` does not apply seeds, and the
 * onboarding actions look their row up by slug and throw when it is missing. A fresh
 * production database could not be walked through the wizard at all. Migration 0014 moved
 * the rows; this is what stops them drifting apart again the next time a driver is added.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves, and what it does not
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROVES:      applying `supabase/migrations/*.sql` in order to an empty database — and
 *              NOTHING else, no seed — leaves an `integrations` row for every slug in
 *              INTEGRATION_CATALOG, with the kind the catalogue declares.
 *
 * DOES NOT:    connect to the hosted project, or say whether it has had 0014 pushed. Run
 *              `supabase db push` for that; this is the check that runs anywhere.
 *
 * Usage: node scripts/check-catalog-rows.mjs [admin-db-url]
 *        (or set DATABASE_URL; needs CREATE DATABASE privilege)
 */

import { catalogEntries } from './lib/catalog.mjs';
import { listMigrations } from './lib/migrations.mjs';
import { describeSqlError, rows as queryRows, withClient } from './lib/pg.mjs';

const adminUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('usage: node scripts/check-catalog-rows.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const scratch = `kiln_catalog_${process.pid}`;

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

// Throws rather than returning an empty list if the descriptor shape changed — a check
// that quietly stops checking would report PASS forever. See scripts/lib/catalog.mjs.
const entries = catalogEntries();

let created = false;
let exitCode = 0;
const problems = [];
let rowCount = 0;

try {
  await withClient(adminUrl, async (admin) => {
    // CREATE DATABASE cannot run inside a transaction block, which is why this connects to
    // the admin database rather than reusing a pooled connection elsewhere.
    await admin.query(`drop database if exists ${scratch}`);
    await admin.query(`create database ${scratch}`);
    created = true;
  });

  await withClient(withDatabase(adminUrl, scratch), async (client) => {
    // Migrations only. Applying the seed here would defeat the entire point.
    for (const m of listMigrations()) {
      const sql = m.sql;
      try {
        await client.query(sql);
      } catch (err) {
        console.error(`\nMigration ${m.file} failed to apply to an empty database:\n`);
        console.error(describeSqlError(err, sql));
        process.exit(1);
      }
    }

    const rows = await queryRows(client, 'select slug, kind from integrations order by slug');
    rowCount = rows.length;
    const bySlug = new Map(rows.map((r) => [r.slug, r.kind]));

    for (const entry of entries) {
      const kind = bySlug.get(entry.slug);
      if (kind === undefined) {
        problems.push(
          `${entry.slug} — in the catalogue, no integrations row after a migrations-only apply. ` +
            'The onboarding action looks this row up by slug and throws when it is absent, so ' +
            'the wizard step for it cannot be walked on a pushed database. Add it to a migration.',
        );
      } else if (kind !== entry.kind) {
        problems.push(`${entry.slug} — catalogue says kind '${entry.kind}', the row says '${kind}'.`);
      }
    }
  });
} finally {
  if (created) {
    try {
      await withClient(adminUrl, (admin) =>
        admin.query(`drop database if exists ${scratch} with (force)`),
      );
    } catch {
      console.error(`warning: could not drop scratch database ${scratch}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} catalogue integration(s) unreachable on a fresh push:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  exitCode = 1;
} else {
  console.log(
    `catalogue rows ok — all ${entries.length} integrations exist after migrations alone ` +
      `(${rowCount} rows in the table).`,
  );
}

process.exit(exitCode);
