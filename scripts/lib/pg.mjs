/**
 * Postgres over the wire, via `pg`.
 *
 * Replaces shelling out to `psql`, which was a machine assumption — the one thing these
 * scripts existed to remove. `pg` is a devDependency: nothing in `src/` imports it and it
 * never ships to a runtime.
 *
 * Two things came free with the change and are worth knowing about:
 *
 *   - **Bind parameters.** A migration's text goes into the ledger as a parameter rather
 *     than a quoted literal, so there is no dollar-quote tag to collide with a function
 *     body. The bundle still needs the literal form; that lives in `migrations.mjs`.
 *
 *   - **Structured errors.** `err.code` is a SQLSTATE or a libuv errno, so a connection
 *     failure can be classified by what it *is* rather than by matching English in a
 *     message that varies by platform and locale.
 *
 * What it did NOT change: a database this network cannot reach is still unreachable.
 * `db-bundle.mjs` deliberately does not import this file — see the header there.
 */

import pg from 'pg';

import { parseUrl } from './migrations.mjs';

const LOCAL = /^(localhost|127\.0\.0\.1|::1|)$/;

/**
 * TLS, following libpq's rules rather than inventing our own.
 *
 * This matters because `psql` and `pg` disagree by default: libpq defaults to `prefer`
 * (encrypt if the server offers it, do not verify the certificate), while `pg` defaults to
 * no TLS at all — which a hosted Supabase project refuses outright. Silently swapping one
 * for the other would turn "it worked yesterday" into a connection error with no
 * explanation, so the libpq semantics are reproduced explicitly:
 *
 *   disable                 no TLS
 *   require (default)       encrypt, do not verify — what psql was already doing
 *   verify-ca, verify-full  encrypt and verify the chain
 *
 * `require` not verifying is libpq's actual behaviour, not a shortcut taken here: libpq
 * only authenticates the server under the two `verify-` modes. Put `?sslmode=verify-full`
 * in the URL if you want the stronger guarantee; Supabase publishes a CA certificate for
 * it in the dashboard.
 */
function sslFor(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }

  const mode = u.searchParams.get('sslmode') ?? (LOCAL.test(u.hostname) ? 'disable' : 'require');

  if (mode === 'disable') return false;
  if (mode === 'verify-ca' || mode === 'verify-full') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

/** Connect, run `fn`, and always close — including when `fn` throws. */
export async function withClient(url, fn, { timeoutMs = 15_000 } = {}) {
  const client = new pg.Client({
    connectionString: url,
    ssl: sslFor(url),
    // Without this a blocked port hangs until the OS gives up, which on some systems is
    // minutes. A script that hangs is the failure mode this tooling exists to end.
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: 120_000,
    application_name: 'kiln-scripts',
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** `{ ok: true, client }` or `{ ok: false, error }`. For callers that classify failures. */
export async function tryConnect(url, { timeoutMs = 15_000 } = {}) {
  const client = new pg.Client({
    connectionString: url,
    ssl: sslFor(url),
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: 120_000,
    application_name: 'kiln-scripts',
  });

  try {
    await client.connect();
    return { ok: true, client };
  } catch (error) {
    await client.end().catch(() => {});
    return { ok: false, error };
  }
}

/** First column of the first row, or null. */
export async function scalar(client, sql, params) {
  const r = await client.query(sql, params);
  if (r.rows.length === 0) return null;
  return Object.values(r.rows[0])[0];
}

export async function rows(client, sql, params) {
  const r = await client.query(sql, params);
  return r.rows;
}

/**
 * Turn a connection failure into a sentence that names the actual cause.
 *
 * The point of the whole exercise: every one of these presents as "push failed", and they
 * have completely different fixes. The Supabase-specific ones especially, where the
 * hostname the dashboard hands you is often not the one that will work from a home or
 * office network.
 *
 * Keyed on `err.code` where there is one. Those are libuv errnos and SQLSTATEs — stable,
 * unlike the message text psql was previously matched on.
 */
export function classifyConnectionError(err, url) {
  const code = err?.code ?? '';
  const message = (err?.message ?? String(err)).toLowerCase();
  const parsed = parseUrl(url);
  const isDirect = /^db\..*\.supabase\.co$/.test(parsed.host ?? '');
  const isPooler = /pooler\.supabase\.com$/.test(parsed.host ?? '');

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      cause: 'DNS — the hostname does not resolve.',
      remedy: isDirect
        ? 'Check the project ref in the hostname. If it is right, the project may be paused: ' +
          'a paused Supabase project stops resolving. Open the dashboard and resume it.'
        : 'Check the hostname for a typo, and that no VPN or split-DNS is interfering.',
    };
  }

  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return {
      cause: 'Routing — the host resolved but there is no path to it.',
      remedy: isDirect
        ? 'This is almost certainly IPv6. `db.<ref>.supabase.co` resolves to an IPv6 address ' +
          'on current projects, and most home and office networks have no IPv6 route. Use the ' +
          'Session pooler string instead: dashboard → Project Settings → Database → Connection ' +
          'string → Session mode. Its host ends in `.pooler.supabase.com`, it is IPv4, and it ' +
          'is safe for migrations. This is the single most likely reason the CLI failed.'
        : 'No route to the host. Try another network, or use the browser paste path ' +
          '(`pnpm db:bundle`).',
    };
  }

  if (code === 'ETIMEDOUT' || /timeout/.test(message)) {
    return {
      cause: 'Timed out — nothing answered on that port.',
      remedy:
        'Outbound Postgres is commonly blocked on corporate and cafe networks; the browser is ' +
        'not, because it uses 443. If the Supabase dashboard opens but nothing connects from ' +
        'here, that is the answer, and `pnpm db:bundle` is the way through it.',
    };
  }

  if (code === 'ECONNREFUSED') {
    return {
      cause: 'Refused — something answered and rejected the connection.',
      remedy: `Check the port (${parsed.port}). Supabase uses 5432 for direct and session-mode ` +
        'pooler connections, 6543 for the transaction pooler. A refusal usually means the wrong ' +
        'one for that hostname.',
    };
  }

  // SQLSTATE 28P01 is invalid_password; 28000 is invalid_authorization_specification.
  if (code === '28P01' || code === '28000' || /password authentication/.test(message)) {
    return {
      cause: 'Reached the database; the credentials were rejected.',
      remedy:
        'Reset the password in Project Settings → Database. If it contains @ : / or #, it must ' +
        'be percent-encoded in the URL — that alone produces this exact error. On a pooler ' +
        'connection the username must be `postgres.<project-ref>`, not `postgres`.',
    };
  }

  if (/tenant or user not found/.test(message)) {
    return {
      cause: 'The pooler rejected the username.',
      remedy:
        'Pooler connections need the username `postgres.<project-ref>`, not `postgres`. Copy the ' +
        'string from the dashboard rather than editing a direct one by hand.',
    };
  }

  if (code === '3D000') {
    return {
      cause: 'Connected, but that database does not exist.',
      remedy: `The URL asks for "${parsed.database}". Supabase projects use "postgres".`,
    };
  }

  // The server closed the connection during TLS negotiation, or the chain failed. Both
  // land here and the fix differs, so both are named.
  if (
    /self[- ]signed|unable to verify|certificate/.test(message) ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN'
  ) {
    return {
      cause: 'TLS certificate verification failed.',
      remedy:
        'Only happens with sslmode=verify-ca or verify-full in the URL. Either download the ' +
        "project's CA certificate from the dashboard and point PGSSLROOTCERT at it, or drop " +
        'back to sslmode=require, which encrypts without authenticating the server — the same ' +
        'thing psql was doing by default.',
    };
  }

  if (/server does not support ssl|the server does not support ssl/.test(message)) {
    return {
      cause: 'The server refused TLS.',
      remedy:
        'Expected on a plain local Postgres. Add ?sslmode=disable to a localhost URL; never to ' +
        'a hosted one.',
    };
  }

  if (isPooler && parsed.port === '6543') {
    return {
      cause: 'Connected through the transaction pooler.',
      remedy:
        'Port 6543 is transaction mode, for application traffic rather than schema changes. Use ' +
        'the Session mode string (port 5432 on the same pooler host) for migrations.',
    };
  }

  return {
    cause: `Unrecognised connection failure${code ? ` (${code})` : ''}.`,
    remedy: 'The raw error is below.',
  };
}

/**
 * Which line of `sql` a reported error position falls on.
 *
 * `pg` reports `err.position` as a 1-based character offset into the statement, which is
 * unreadable against a 15,000-character migration. psql printed a line number; losing that
 * would have made this swap a downgrade for the one thing you actually read when a
 * migration fails.
 */
export function lineOfPosition(sql, position) {
  const n = Number(position);
  if (!Number.isFinite(n) || n < 1) return null;
  return sql.slice(0, n).split('\n').length;
}

/** Format a database error the way someone debugging it wants to read it. */
export function describeSqlError(err, sql) {
  const parts = [err.message];
  const line = sql ? lineOfPosition(sql, err.position) : null;
  if (line) parts.push(`at line ${line} of the migration`);
  if (err.detail) parts.push(err.detail);
  if (err.hint) parts.push(`hint: ${err.hint}`);
  return parts.join('\n');
}

export async function ledgerExists(client) {
  return (
    (await scalar(client, "select to_regclass('supabase_migrations.schema_migrations') is not null")) ===
    true
  );
}

/** Applied versions, oldest first. `null` when the ledger table does not exist yet. */
export async function appliedVersions(client) {
  if (!(await ledgerExists(client))) return null;
  const r = await rows(
    client,
    'select version from supabase_migrations.schema_migrations order by version',
  );
  return r.map((x) => x.version);
}

/**
 * Record a migration as applied.
 *
 * The file goes in as a bind parameter, so nothing has to be quoted and no dollar-quote
 * tag can collide with a function body inside the migration.
 */
export async function recordMigration(client, migration) {
  await client.query(
    `insert into supabase_migrations.schema_migrations (version, name, statements)
     values ($1, $2, array[$3::text])
     on conflict (version) do nothing`,
    [migration.version, migration.name, migration.sql],
  );
}
