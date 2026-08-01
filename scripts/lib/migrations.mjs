/**
 * Everything about migrations that needs nothing but Node.
 *
 * **This module must never import a dependency.** `scripts/db-bundle.mjs` — the browser
 * paste path — imports only from here, and that path's whole value is that it works when
 * nothing else does: no Docker, no CLI, no open database port, and no `node_modules`
 * state. A dependency added here would make the last resort depend on the same install
 * that may be the problem.
 *
 * Anything needing a database connection lives in `pg.mjs` instead.
 */

import { readFileSync, readdirSync } from 'node:fs';

export const MIGRATIONS_DIR = 'supabase/migrations';

/** Never print a connection string. This is what goes in output instead. */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return url.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:****@');
  }
}

export function parseUrl(url) {
  try {
    const u = new URL(url);
    return {
      ok: true,
      host: u.hostname,
      port: u.port || '5432',
      user: decodeURIComponent(u.username),
      database: u.pathname.replace(/^\//, '') || '(default)',
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Soft-wrap prose to a terminal width.
 *
 * Lines that begin with whitespace are returned untouched — those are commands, database
 * output and indented lists, where a wrap in the middle produces something that cannot be
 * copied and pasted.
 */
export function wrap(line, width = 76) {
  if (/^\s/.test(line) || line.length <= width) return [line];

  const out = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current && `${current} ${word}`.length > width) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * The migration files on disk, in the order they must be applied.
 *
 * `version` is the leading digits and `name` the rest, which is how the Supabase CLI
 * parses these filenames — so the ledger rows written from this agree with the ones the
 * CLI would have written.
 */
export function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((file) => {
      const m = file.match(/^(\d+)_(.*)\.sql$/);
      return {
        file,
        version: m[1],
        name: m[2],
        path: `${MIGRATIONS_DIR}/${file}`,
        get sql() {
          return readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
        },
      };
    });
}

/**
 * The Supabase CLI's own migration ledger.
 *
 * This is the shape the CLI bootstraps: a `version` primary key, with `statements` and
 * `name` added by `add column if not exists` for databases that predate them. Reproduced
 * exactly so that a CLI that starts working later reads this history as its own and
 * reports the project up to date rather than trying to replay everything.
 *
 * Every statement is `if not exists`, so running this against a database the CLI already
 * initialised converges instead of conflicting. Nothing here alters or drops.
 */
export const LEDGER_DDL = `create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key
);

alter table supabase_migrations.schema_migrations add column if not exists statements text[];
alter table supabase_migrations.schema_migrations add column if not exists name text;`;

/**
 * The first relation a migration creates, or null if it only alters existing ones.
 *
 * Used to answer "has this migration's work already been done by someone pasting SQL?"
 * without trusting the ledger — which is the exact situation where the ledger is the thing
 * that is wrong. Derived from the file rather than a hand-maintained map of version →
 * table, so it keeps working as migrations are added.
 *
 * `to_regclass` resolves tables and views alike, so either anchor answers the question.
 */
export function firstRelation(migration) {
  const m = migration.sql.match(
    /^\s*create\s+(?:or\s+replace\s+)?(?:table|view|materialized\s+view)\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/im,
  );
  return m ? m[1] : null;
}

/**
 * A dollar-quote tag that does not occur in `text`.
 *
 * Three migrations contain `$$` of their own — the Vault wrappers and the recipe counter
 * function — so a fixed tag would terminate a literal in the middle of a function body and
 * produce a syntax error a long way from its cause.
 */
export function safeTag(text, base) {
  let tag = `$${base}$`;
  let n = 0;
  while (text.includes(tag)) tag = `$${base}_${++n}$`;
  return tag;
}

/**
 * The INSERT that records a migration as applied, as literal SQL with the file inlined.
 *
 * For the bundle, which has to emit text that a browser will paste. `db-push.mjs` sends
 * the same values as bind parameters instead — no quoting and no tag collision to reason
 * about, which is one of the things a real client bought.
 */
export function ledgerInsert(migration) {
  const sql = migration.sql;
  const tag = safeTag(sql, `kiln_${migration.version}`);
  return (
    'insert into supabase_migrations.schema_migrations (version, name, statements)\n' +
    `values ('${migration.version}', '${migration.name.replace(/'/g, "''")}', ` +
    `array[${tag}${sql}${tag}])\n` +
    'on conflict (version) do nothing;'
  );
}
