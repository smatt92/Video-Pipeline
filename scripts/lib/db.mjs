/**
 * Talking to Postgres from a script, without Docker, the Supabase CLI, or a new dependency.
 *
 * Everything here shells out to `psql`. That is a real requirement and it is stated
 * loudly rather than assumed — see `requirePsql()`. The alternative is the `pg` package,
 * which CLAUDE.md says to ask before adding, and which would not help with the failure
 * that most often blocks a laptop anyway: the port being unreachable.
 */

import { execFileSync } from 'node:child_process';
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

/**
 * Soft-wrap prose to a terminal width.
 *
 * Lines that begin with whitespace are returned untouched — those are commands, psql
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

export function psqlAvailable() {
  try {
    execFileSync('psql', ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

export function requirePsql() {
  if (psqlAvailable()) return;
  console.error(
    '\npsql is not on PATH, and every database script here needs it.\n\n' +
      '  macOS    brew install libpq && brew link --force libpq\n' +
      '  Debian   sudo apt-get install postgresql-client\n' +
      '  Windows  install the PostgreSQL client tools, or use WSL\n\n' +
      'If installing it is not worth the time: `pnpm db:bundle` writes a single SQL file\n' +
      'you paste into the Supabase SQL editor in the browser. It needs nothing installed.\n',
  );
  process.exit(2);
}

/**
 * Run psql. Returns `{ ok, stdout, stderr }` and never throws on a database error —
 * callers here want to classify a failure, not catch an exception.
 *
 * PGCONNECT_TIMEOUT is set so an unreachable host fails in seconds. The default is no
 * timeout at all, and a script that hangs forever is the failure this whole file exists
 * to stop happening.
 */
export function psql(url, args, { timeoutSeconds = 15, input } = {}) {
  try {
    const stdout = execFileSync('psql', [url, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: input ?? '',
      env: { ...process.env, PGCONNECT_TIMEOUT: String(timeoutSeconds) },
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: (err.stderr ?? err.message ?? '').toString(),
    };
  }
}

/** One scalar, or null. */
export function scalar(url, sql) {
  const r = psql(url, ['-Atqc', sql]);
  if (!r.ok) return null;
  const v = r.stdout.trim();
  return v === '' ? null : v;
}

/**
 * Turn a psql connection failure into a sentence that names the actual cause.
 *
 * This is the point of the whole exercise. Every one of these presents as "push failed",
 * and they have completely different fixes — the Supabase-specific ones especially, where
 * the hostname you are given in the dashboard is often not the one that will work from a
 * home or office network.
 */
export function classifyConnectionError(stderr, url) {
  const e = stderr.toLowerCase();
  const parsed = parseUrl(url);
  const isDirect = /^db\..*\.supabase\.co$/.test(parsed.host ?? '');
  const isPooler = /pooler\.supabase\.com$/.test(parsed.host ?? '');

  // psql sometimes reports a bare `psql: error:` with nothing after it — a resolver that
  // returns no address and no reason, which happens behind some proxies and split-DNS
  // setups. Falling through to "unrecognised" there would print an empty message and no
  // advice, so the URL's own shape answers instead: it is the best signal available and
  // for a direct Supabase host it is very likely the right one.
  if (stderr.replace(/psql:\s*error:?/gi, '').trim().length < 3) {
    return {
      cause: 'The connection failed and psql gave no reason — usually DNS returning nothing.',
      remedy: isDirect
        ? 'This is the direct host, which is IPv6-only on current Supabase projects. If this ' +
          'network has no IPv6 route the lookup can fail silently like this. Use the Session ' +
          'pooler string (Project Settings → Database → Connection string → Session mode); it ' +
          'is IPv4 and safe for migrations. Also confirm the project is not paused.'
        : 'Check the hostname, any VPN or proxy, and whether the project is paused. If the ' +
          'dashboard opens in a browser but nothing connects from here, the network is ' +
          'blocking Postgres and `pnpm db:bundle` is the way through.',
    };
  }

  if (/could not translate host name|name or service not known|nodename nor servname/.test(e)) {
    return {
      cause: 'DNS — the hostname does not resolve.',
      remedy: isDirect
        ? 'Check the project ref in the hostname. If it is right, the project may be paused: ' +
          'a paused Supabase project stops resolving. Open the dashboard and resume it.'
        : 'Check the hostname for a typo, and that any VPN or split-DNS is not interfering.',
    };
  }

  if (/network is unreachable|no route to host/.test(e)) {
    return {
      cause: 'Routing — the host resolved but there is no path to it.',
      remedy: isDirect
        ? 'This is almost certainly IPv6. `db.<ref>.supabase.co` resolves to an IPv6 address ' +
          'on current projects, and most home and office networks have no IPv6 route. Use the ' +
          'Session pooler string instead: dashboard → Project Settings → Database → Connection ' +
          'string → Session mode. Its host ends in `.pooler.supabase.com`, it is IPv4, and it ' +
          'is safe for migrations. This is the single most likely reason the CLI failed.'
        : 'No route to the host. Try from another network, or use the browser paste path ' +
          '(`pnpm db:bundle`).',
    };
  }

  if (/timeout expired|operation timed out|connection timed out/.test(e)) {
    return {
      cause: 'Timed out — nothing answered on that port.',
      remedy:
        'Outbound Postgres is commonly blocked on corporate and cafe networks; the browser ' +
        'is not, because it uses 443. If you can open the Supabase dashboard but not connect ' +
        'here, that is the answer, and `pnpm db:bundle` is the way through it.',
    };
  }

  if (/connection refused/.test(e)) {
    return {
      cause: 'Refused — something answered and rejected the connection.',
      remedy: `Check the port (${parsed.port}). Supabase uses 5432 for direct and session-mode ` +
        'pooler connections, 6543 for the transaction pooler. A refusal usually means the wrong ' +
        'one for that hostname.',
    };
  }

  if (/tenant or user not found/.test(e)) {
    return {
      cause: 'The pooler rejected the username.',
      remedy:
        'Pooler connections need the username `postgres.<project-ref>`, not `postgres`. Copy ' +
        'the string from the dashboard rather than editing a direct one by hand.',
    };
  }

  if (/password authentication failed|authentication failed/.test(e)) {
    return {
      cause: 'Reached the database; the password was rejected.',
      remedy:
        'Reset it in Project Settings → Database. If the password contains @ : / or #, it must ' +
        'be percent-encoded in the URL — that alone produces this exact error.',
    };
  }

  if (/ssl|server does not support ssl/.test(e)) {
    return {
      cause: 'TLS negotiation failed.',
      remedy: 'Supabase requires SSL. Do not set `sslmode=disable` in the connection string.',
    };
  }

  if (isPooler && parsed.port === '6543') {
    return {
      cause: 'Connected through the transaction pooler.',
      remedy:
        'Port 6543 is transaction mode, which is for application traffic, not schema changes. ' +
        'Use the Session mode string (port 5432 on the same pooler host) for migrations.',
    };
  }

  return { cause: 'Unrecognised connection failure.', remedy: 'The raw psql output is below.' };
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

export function ledgerExists(url) {
  return (
    scalar(
      url,
      "select to_regclass('supabase_migrations.schema_migrations') is not null",
    ) === 't'
  );
}

/** Applied versions, oldest first. `null` when the ledger table does not exist yet. */
export function appliedVersions(url) {
  if (!ledgerExists(url)) return null;
  const r = psql(url, [
    '-Atqc',
    'select version from supabase_migrations.schema_migrations order by version',
  ]);
  if (!r.ok) return null;
  return r.stdout.trim().split('\n').filter(Boolean);
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

/** The INSERT that records a migration as applied, with the file kept verbatim. */
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
