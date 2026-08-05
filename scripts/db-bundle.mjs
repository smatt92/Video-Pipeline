#!/usr/bin/env node
/**
 * Write one SQL file to paste into the Supabase SQL editor.
 *
 * The path that always works. It needs no psql, no CLI, no Docker and no open Postgres
 * port — only the browser, which reaches Supabase over 443 like every other website. When
 * a laptop cannot open a database connection but can open the dashboard, this is the
 * difference between a night of network diagnosis and a working database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why it is safe to run twice
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The file is one transaction, and it opens with a guard that raises if any of the
 * versions it carries is already in the ledger. So a second paste stops on its first
 * statement with a sentence saying so, and rolls back — it cannot half-apply, and it
 * cannot corrupt the ledger.
 *
 * The migrations themselves are included verbatim, not wrapped or rewritten. Three of them
 * define functions with dollar-quoted bodies, and quoting a migration inside a string
 * literal to make it conditional is how you get a syntax error reported a hundred lines
 * from its cause. Verbatim text inside one transaction is both simpler and more honest:
 * either every statement in the file committed, or none did.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this file imports nothing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It reads only `lib/migrations.mjs`, which has no dependencies of its own — no `pg`, no
 * psql, nothing from node_modules. That is deliberate and load-bearing: this is the path
 * that works when the others do not, and a last resort that needs a working install is
 * not a last resort. It writes a file; the browser does the rest.
 *
 * Usage: node scripts/db-bundle.mjs [--from 0008] [--to 0014] [--lean] [--out path.sql]
 *
 * `--lean` drops each migration's text from the ledger row it writes, which is about a
 * third of the file size. Nothing in this repo reads that column; see `ledgerInsert`.
 *
 * With no range it bundles everything. Run `pnpm db:doctor` first: it prints exactly which
 * versions are already applied, which is the number to pass to --from.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { LEDGER_DDL, ledgerInsert, listMigrations } from './lib/migrations.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] ?? null);
};

const from = opt('from');
const to = opt('to');
/** Omit each migration's text from the ledger row. Roughly a third the file size. */
const lean = args.includes('--lean');

const all = listMigrations();
const selected = all.filter(
  (m) => (!from || m.version >= from) && (!to || m.version <= to),
);

if (selected.length === 0) {
  console.error(
    `No migrations in that range. On disk: ${all[0]?.version} … ${all[all.length - 1]?.version}\n`,
  );
  process.exit(2);
}

const range =
  selected.length === all.length
    ? 'all'
    : `${selected[0].version}-${selected[selected.length - 1].version}`;

const out = opt('out') ?? `supabase/bundles/migrations-${range}.sql`;

const versions = selected.map((m) => `'${m.version}'`).join(', ');

const header = `-- Kiln — migrations ${selected[0].version} to ${selected[selected.length - 1].version}, bundled for the Supabase SQL editor.
--
-- GENERATED FILE. Do not edit; regenerate with \`pnpm db:bundle\`.
--
-- ── How to use ──────────────────────────────────────────────────────────────
--
--   1. Supabase dashboard → SQL Editor → New query
--   2. Paste this entire file
--   3. Run
--
-- Expected output is "Success. No rows returned". Anything else means nothing was
-- applied: the whole file is one transaction, so a failure rolls back every statement in
-- it. There is no half-applied state to clean up.
--
-- The last statement in this file is \`notify pgrst, 'reload schema'\`. Without it the
-- app keeps reporting "Could not find the table 'public.X' in the schema cache" even
-- though every table exists — PostgREST caches the schema and pasting SQL does not tell
-- it to reload. It is included; you do not need to run it separately.
--
-- ── Running it twice ────────────────────────────────────────────────────────
--
-- Safe. The guard below raises before any schema change if any of these versions is
-- already recorded, and the transaction rolls back. You will see an error that says so in
-- words — that error is the file working, not failing.
--
-- ── What it records ─────────────────────────────────────────────────────────
--
-- Each migration is written into supabase_migrations.schema_migrations, the same table
-- \`supabase db push\` uses. If the CLI starts working later it reads this as its own
-- history and reports the project up to date rather than replaying anything.
--
-- Migrations included (${selected.length}):
${selected.map((m) => `--   ${m.version}  ${m.name}`).join('\n')}

begin;

${LEDGER_DDL}

-- ── Guard ───────────────────────────────────────────────────────────────────
do $kiln_guard$
declare
  seen text;
begin
  select string_agg(version, ', ' order by version) into seen
  from supabase_migrations.schema_migrations
  where version in (${versions});

  if seen is not null then
    raise exception
      'Already applied: %. Nothing in this file has been run and the transaction is rolling back. Run pnpm db:doctor, then pnpm db:bundle --from <the next version> for what is actually outstanding.',
      seen;
  end if;
end
$kiln_guard$;
`;

const body = selected
  .map((m) => {
    const banner =
      `-- ════════════════════════════════════════════════════════════════════════════\n` +
      `-- ${m.file}\n` +
      `-- ════════════════════════════════════════════════════════════════════════════`;
    // A notice per migration, so the editor's output panel shows how far it got if
    // something fails — the error alone does not say which file it came from.
    const marker = `do $kiln_progress$ begin raise notice 'applying ${m.version} ${m.name}'; end $kiln_progress$;`;
    return `${banner}\n\n${marker}\n\n${m.sql.trimEnd()}\n\n${ledgerInsert(m, { lean })}\n`;
  })
  .join('\n');

const footer = `
-- ════════════════════════════════════════════════════════════════════════════
commit;

-- ── Tell PostgREST the schema changed ───────────────────────────────────────
--
-- Outside the transaction, and not optional.
--
-- Supabase serves the app through PostgREST, which caches the schema in memory. The CLI
-- reloads that cache after a push; pasting SQL into the editor does not. So every table,
-- view and function this file created exists in the database and is invisible to the app
-- until this fires — and the error you get is "Could not find the table 'public.X' in the
-- schema cache", which reads exactly like the migration never ran.
--
-- That sentence cost an evening. It is in the file now so it cannot be forgotten.
notify pgrst, 'reload schema';

-- Confirm from the editor:
--   select version, name from supabase_migrations.schema_migrations order by version;
--   select slug, kind, is_enabled from integrations order by slug;
`;

const contents = `${header}\n${body}${footer}`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, contents);

const kb = Math.round(contents.length / 1024);
console.log(`\nwrote ${out}  (${selected.length} migrations, ${kb} kB)\n`);
console.log(`  ${selected.map((m) => m.version).join(', ')}\n`);
console.log('Paste it into the Supabase SQL editor and run it. Expect "Success. No rows returned".');

if (contents.length > 200_000) {
  console.log(
    `\nThat is a large paste and the editor gets sluggish past a few hundred kB. If it\n` +
      'struggles, split it: `pnpm db:bundle --from X --to Y` twice, running each in order.',
  );
}

console.log('');
