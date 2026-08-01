#!/usr/bin/env node
/**
 * Fail if src/lib/db/enums.ts disagrees with the database's CHECK constraints.
 *
 * The generated DB types render every CHECK-constrained column as `string`, so the Zod
 * enums in enums.ts are the only thing giving those columns a closed set in TypeScript.
 * Hand-written means driftable: a migration adds 'paused' to shots.status, nobody
 * updates the enum, and the app silently cannot represent a state the DB now allows.
 *
 * This reads the live constraints and compares. Run against the same database the
 * migrations were applied to.
 *
 * Usage: node scripts/check-enums.mjs [db-url]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/check-enums.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

// Pull the declared sets straight out of the source rather than importing it, so this
// script needs no TypeScript toolchain and can run before a build.
const src = readFileSync('src/lib/db/enums.ts', 'utf8');

function declaredValues(exportName) {
  const re = new RegExp(`export const ${exportName} = z\\.enum\\(\\[([^\\]]*)\\]`, 's');
  const m = src.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

const mapMatch = src.match(/ENUM_CONSTRAINT_MAP = \{(.*?)\n\} as const/s);
if (!mapMatch) {
  console.error('could not find ENUM_CONSTRAINT_MAP in src/lib/db/enums.ts');
  process.exit(2);
}

const pairs = [...mapMatch[1].matchAll(/'([\w.]+)':\s*(\w+),/g)].map(([, col, name]) => ({
  column: col,
  exportName: name,
}));

// Extract the quoted literals from each CHECK expression. pg_get_constraintdef renders
// them as: CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))
const sql = `
select
  rel.relname || '.' || att.attname as column_ref,
  pg_get_constraintdef(con.oid)     as def
from pg_constraint con
join pg_class rel      on rel.oid = con.conrelid
join pg_namespace nsp  on nsp.oid = rel.relnamespace
join unnest(con.conkey) as k(attnum) on true
join pg_attribute att  on att.attrelid = rel.oid and att.attnum = k.attnum
where con.contype = 'c' and nsp.nspname = 'public';
`;

let rows;
try {
  const out = execFileSync('psql', [dbUrl, '-At', '-F', '', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rows = out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [column_ref, def] = line.split('');
      return { column_ref, def };
    });
} catch (err) {
  console.error(`could not query the database: ${err.message}`);
  process.exit(2);
}

const actual = new Map();
for (const { column_ref, def } of rows) {
  const literals = [...def.matchAll(/'([^']+)'::text/g)].map((x) => x[1]);
  if (literals.length) actual.set(column_ref, literals.sort());
}

let failed = 0;
for (const { column, exportName } of pairs) {
  const declared = declaredValues(exportName);
  const live = actual.get(column);

  if (!declared) {
    console.error(`✗ ${column}: could not parse z.enum for export "${exportName}"`);
    failed++;
    continue;
  }
  if (!live) {
    console.error(`✗ ${column}: no CHECK constraint found in the database`);
    failed++;
    continue;
  }
  if (JSON.stringify(declared) !== JSON.stringify(live)) {
    const onlyCode = declared.filter((v) => !live.includes(v));
    const onlyDb = live.filter((v) => !declared.includes(v));
    console.error(`✗ ${column}: enums.ts and the database disagree`);
    if (onlyCode.length) console.error(`    in enums.ts but not in the DB: ${onlyCode.join(', ')}`);
    if (onlyDb.length) console.error(`    in the DB but not in enums.ts: ${onlyDb.join(', ')}`);
    failed++;
    continue;
  }
  console.log(`✓ ${column} (${live.length}) `);
}

// A CHECK constraint the code has no enum for is also drift — it means a closed set
// exists that TypeScript knows nothing about.
for (const column of actual.keys()) {
  if (!pairs.some((p) => p.column === column)) {
    console.error(`✗ ${column}: CHECK constraint has no entry in ENUM_CONSTRAINT_MAP`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} enum mismatch(es). Fix enums.ts, or add the migration you forgot.`);
  process.exit(1);
}
console.log('\nenums.ts matches every CHECK constraint in the database.');
