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

import { readFileSync } from 'node:fs';

import { withClient } from './lib/pg.mjs';

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

/**
 * How many of the schema's tables exist here at all.
 *
 * Asked before the constraints are, and the reason is a real incident: this script was
 * pointed at a database whose `public` schema had been dropped, and it reported
 * "27 enum mismatch(es). Fix enums.ts, or add the migration you forgot." Every line said
 * "no CHECK constraint found in the database", which is literally true and completely
 * misleading — the constraints were not missing, the *tables* were, and the suggested
 * remedy sent someone to edit a file that was already correct.
 *
 * That is the failure this project keeps building tools to remove: two very different
 * problems producing one indistinguishable message. A drift report and an unmigrated
 * database are not the same finding and must not print the same way.
 */
const SCHEMA_PROBE = `
select rel.relname as table_name, att.attname as column_name
from pg_class rel
join pg_namespace nsp on nsp.oid = rel.relnamespace
left join pg_attribute att on att.attrelid = rel.oid and att.attnum > 0 and not att.attisdropped
where nsp.nspname = 'public' and rel.relkind = 'r';
`;

let rows;
let shape = [];
try {
  // Rows arrive as objects rather than delimiter-split text. The previous version passed
  // -F with a control character to psql and split on it, which worked only because no
  // constraint definition happened to contain that byte. A real client removes the
  // question rather than answering it carefully.
  ({ rows, shape } = await withClient(dbUrl, async (client) => ({
    shape: (await client.query(SCHEMA_PROBE)).rows,
    rows: (await client.query(sql)).rows,
  })));
} catch (err) {
  console.error(`could not query the database: ${err.message}`);
  process.exit(2);
}

const liveTables = new Set(shape.map((r) => r.table_name));
const liveColumns = new Set(
  shape.filter((r) => r.column_name).map((r) => `${r.table_name}.${r.column_name}`),
);

if (liveTables.size === 0) {
  console.error(
    '\nThis database has no tables in `public`, so there are no CHECK constraints to ' +
      'compare against.\n\n' +
      '  This is NOT enum drift. enums.ts may be perfectly correct — nothing here can say.\n' +
      '  Apply the migrations first:  pnpm db:push "<db-url>"\n\n' +
      'Exit 2 rather than 1, because 1 means "the code and the database disagree" and this ' +
      'run never got far enough to have an opinion.\n',
  );
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
    // Three different problems used to print as one line. A missing table means the
    // migrations are behind; a missing column means a migration was written wrong; a
    // present column with no CHECK means the constraint was dropped or never added. They
    // send you to three different places.
    const [table] = column.split('.');
    if (!liveTables.has(table)) {
      console.error(
        `✗ ${column}: table "${table}" does not exist here. The migrations are behind this ` +
          'database, not enums.ts.',
      );
    } else if (!liveColumns.has(column)) {
      console.error(
        `✗ ${column}: table "${table}" exists but has no column "${column.split('.')[1]}". ` +
          'ENUM_CONSTRAINT_MAP names a column the schema does not have.',
      );
    } else {
      console.error(
        `✗ ${column}: the column exists and carries no CHECK constraint. Either the ` +
          'constraint was dropped, or it was never added and this enum has been a ' +
          'suggestion rather than a guarantee.',
      );
    }
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
