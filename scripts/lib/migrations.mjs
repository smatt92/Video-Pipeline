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
 * What a migration actually does, read out of its own SQL.
 *
 * Derived, never a hand-maintained map of version → description. A map would be correct
 * on the day it was written and wrong by the third migration after it, and the whole
 * point of this is to be trustworthy when someone is trying to work out why a screen is
 * empty.
 *
 * Row counts come from scanning the VALUES list at paren depth zero, so a tuple
 * containing its own parentheses — `jsonb_build_object(...)`, a cast, a function call —
 * counts once rather than several times.
 */
export function migrationEffects(migration) {
  const sql = migration.sql;

  const tables = [...sql.matchAll(/^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][\w]*)/gim)]
    .map((m) => m[1]);
  const views = [
    ...sql.matchAll(/^\s*create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+([a-z_][\w]*)/gim),
  ].map((m) => m[1]);
  // Schema-qualified names are allowed and the schema is dropped: 0011 declares
  // `create function public.record_recipe_compile(...)`, which a bare [a-z_]\w* match
  // reported as a function called "public".
  const functions = [
    ...sql.matchAll(/^\s*create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_][\w]*\.)?([a-z_][\w]*)/gim),
  ].map((m) => m[1]);
  // Per ALTER statement, not per file: one `alter table X` can carry several `add column`
  // clauses, and matching only the first reported 0015 as adding one column when it adds
  // two. Each statement is sliced to its own semicolon before its clauses are read.
  const columns = [];
  const alterRe = /alter\s+table\s+([a-z_][\w]*)/gim;
  let alter;
  while ((alter = alterRe.exec(sql)) !== null) {
    const end = sql.indexOf(';', alterRe.lastIndex);
    const body = sql.slice(alterRe.lastIndex, end === -1 ? sql.length : end);
    for (const c of body.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][\w]*)/gim)) {
      columns.push(`${alter[1]}.${c[1]}`);
    }
  }

  // Inserts, with a tuple count per target table.
  const inserts = [];
  const insertRe = /insert\s+into\s+([a-z_][\w]*)\s*(\([^)]*\))?\s*(values|select)/gim;
  let m;
  while ((m = insertRe.exec(sql)) !== null) {
    const table = m[1];

    if (m[3].toLowerCase() === 'select') {
      inserts.push({ table, rows: null });
      continue;
    }

    // Walk forward from VALUES counting groups that open at depth 0, stopping at the
    // statement's own semicolon (also at depth 0).
    let depth = 0;
    let rows = 0;
    for (let i = insertRe.lastIndex; i < sql.length; i++) {
      const c = sql[i];
      if (c === '(') {
        if (depth === 0) rows++;
        depth++;
      } else if (c === ')') {
        depth--;
        if (depth === 0) {
          // The VALUES list ends at the first closing paren not followed by a comma.
          // Without this, `on conflict (a, b, c)` — which also opens at depth 0 — was
          // counted as one more row, so every insert with a conflict target read one
          // too high. Found by counting 0014's five integrations rows as six.
          const rest = sql.slice(i + 1);
          const next = rest.match(/^\s*(\S)/);
          if (!next || next[1] !== ',') break;
        }
      } else if (c === ';' && depth === 0) {
        break;
      }
    }
    inserts.push({ table, rows });
  }

  // Merge repeat targets, so "3 inserts into rate_card" reads as one line.
  const byTable = new Map();
  for (const i of inserts) {
    const prior = byTable.get(i.table);
    if (prior === undefined) byTable.set(i.table, i.rows);
    else if (prior !== null && i.rows !== null) byTable.set(i.table, prior + i.rows);
  }

  return {
    tables,
    views,
    functions,
    columns,
    inserts: [...byTable.entries()].map(([table, rows]) => ({ table, rows })),
    /** Something whose presence proves this migration ran. Null if it only inserts rows. */
    anchor: tables[0] ?? views[0] ?? null,
    anchorColumn: columns[0] ?? null,
  };
}

/** One line per migration, for a human trying to work out what is missing. */
export function describeEffects(effects) {
  const parts = [];
  if (effects.inserts.length) {
    parts.push(
      'inserts ' +
        effects.inserts
          .map((i) => (i.rows === null ? `rows into ${i.table}` : `${i.rows} into ${i.table}`))
          .join(', '),
    );
  }
  if (effects.tables.length) parts.push(`creates table ${effects.tables.join(', ')}`);
  if (effects.views.length) parts.push(`creates view ${effects.views.join(', ')}`);
  if (effects.functions.length) parts.push(`creates function ${effects.functions.join(', ')}`);
  if (effects.columns.length) {
    const shown = effects.columns.slice(0, 4).join(', ');
    const more = effects.columns.length > 4 ? ` (+${effects.columns.length - 4} more)` : '';
    parts.push(`adds column ${shown}${more}`);
  }
  return parts.length ? parts : ['no schema or row changes detected'];
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
export function ledgerInsert(migration, { lean = false } = {}) {
  const name = migration.name.replace(/'/g, "''");

  /**
   * `lean` omits the migration's own text from the `statements` column.
   *
   * The column exists for the Supabase CLI's benefit; nothing in this repo reads it —
   * `appliedVersions` selects `version` and nothing else, and `check:drift` reads the files
   * on disk. Embedding the SQL means every bundle carries each migration twice, once to run
   * and once as a string literal, and that roughly triples the file.
   *
   * That matters because of what the bundle is *for*. It is the path that works when the
   * others do not, and a 278 kB paste that the SQL editor will not swallow is not a working
   * path. A 278 kB bundle failed to apply and a lean one is about a third of that.
   *
   * The cost is real and narrow: a project migrated this way cannot have its migration text
   * reconstructed from the database by `supabase db pull`. The text is in git, which is
   * where it belongs, and `db:push` still writes the full statements when it is usable.
   */
  if (lean) {
    return (
      'insert into supabase_migrations.schema_migrations (version, name, statements)\n' +
      `values ('${migration.version}', '${name}', ` +
      `array['-- applied from a lean bundle; text in supabase/migrations/${migration.file}'])\n` +
      'on conflict (version) do nothing;'
    );
  }

  const sql = migration.sql;
  const tag = safeTag(sql, `kiln_${migration.version}`);
  return (
    'insert into supabase_migrations.schema_migrations (version, name, statements)\n' +
    `values ('${migration.version}', '${name}', ` +
    `array[${tag}${sql}${tag}])\n` +
    'on conflict (version) do nothing;'
  );
}
