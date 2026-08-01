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

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

import { catalogEntries } from './lib/catalog.mjs';

const adminUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!adminUrl) {
  console.error('usage: node scripts/check-catalog-rows.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const scratch = `kiln_catalog_${process.pid}`;

function psql(url, args) {
  return execFileSync('psql', [url, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

let created = false;

process.on('exit', () => {
  if (!created) return;
  try {
    psql(adminUrl, ['-q', '-c', `drop database if exists ${scratch} with (force)`]);
  } catch {
    console.error(`warning: could not drop scratch database ${scratch}`);
  }
});
process.on('SIGINT', () => process.exit(130));

// Throws rather than returning an empty list if the descriptor shape changed — a check
// that quietly stops checking would report PASS forever. See scripts/lib/catalog.mjs.
const entries = catalogEntries();

psql(adminUrl, ['-q', '-c', `drop database if exists ${scratch}`]);
psql(adminUrl, ['-q', '-c', `create database ${scratch}`]);
created = true;

const scratchUrl = withDatabase(adminUrl, scratch);

// Migrations only. Applying the seed here would defeat the entire point.
const migrations = readdirSync('supabase/migrations')
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of migrations) {
  try {
    psql(scratchUrl, ['-v', 'ON_ERROR_STOP=1', '-q', '-f', `supabase/migrations/${file}`]);
  } catch (err) {
    console.error(`\nMigration ${file} failed to apply to an empty database:\n`);
    console.error(err.stderr ?? err.message);
    process.exit(1);
  }
}

const rows = psql(scratchUrl, ['-Atq', '-c', 'select slug, kind from integrations order by slug'])
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [slug, kind] = line.split('|');
    return { slug, kind };
  });

const bySlug = new Map(rows.map((r) => [r.slug, r.kind]));
const problems = [];

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

if (problems.length > 0) {
  console.error(`\n${problems.length} catalogue integration(s) unreachable on a fresh push:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  `catalogue rows ok — all ${entries.length} integrations exist after migrations alone ` +
    `(${rows.length} rows in the table).`,
);
