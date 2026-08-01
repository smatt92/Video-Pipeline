#!/usr/bin/env node
/**
 * Tell me which failure this is.
 *
 * Every environment problem in this project so far has presented identically: something
 * did not work, and three plausible causes had the same symptom. An unset variable, a
 * blocked port, an unapplied migration and a missing row all end at "the wizard threw".
 * This runs the checks in dependency order and names the one that is actually wrong.
 *
 * Ordered on purpose. Some checks are *gates*: nothing downstream can be read without a
 * connection, and unapplied migrations guarantee missing rows, so a failure there reports
 * everything after it as BLOCKED rather than repeating an entailed failure five times.
 * Checks that stand on their own are never allowed to block — a missing Vault extension
 * says nothing about whether the migrations applied, and hiding four real answers behind
 * it was the first version of this file's own bug.
 *
 * Usage: node scripts/doctor.mjs [db-url]
 *        (or set DATABASE_URL, including in .env.local)
 *
 * Exit codes: 0 all passed · 1 something failed · 2 something could not be checked
 */

import { execFileSync } from 'node:child_process';

import { breakerDrivers, catalogEntries, catalogRates } from './lib/catalog.mjs';
import {
  appliedVersions,
  classifyConnectionError,
  firstRelation,
  ledgerExists,
  listMigrations,
  maskUrl,
  parseUrl,
  psql,
  psqlAvailable,
  scalar,
  wrap,
} from './lib/db.mjs';

const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.DATABASE_URL;

const results = [];
let blocked = null; // set by the first failure; everything after it reports as blocked

function report(status, name, lines = []) {
  results.push({ status, name });
  const badge = { pass: ' PASS ', fail: ' FAIL ', warn: ' WARN ', skip: ' SKIP ', block: 'BLOCKED' }[status];
  console.log(`${badge}  ${name}`);
  for (const line of lines) for (const w of wrap(line)) console.log(`         ${w}`);
  if (lines.length) console.log('');
}

/**
 * Run a check unless an earlier *gate* failed.
 *
 * `gate: true` means a later check's result would be entailed by this one's failure
 * rather than independent of it — no connection means nothing downstream can be read at
 * all, and unapplied migrations guarantee missing rows. Those are reported as BLOCKED, so
 * the output has one thing to fix rather than five.
 *
 * Everything else is `gate: false` and stands alone. The Vault check is the reason this
 * distinction exists: it can fail while migrations, enums and rows are all perfectly
 * checkable, and hiding four real answers behind it was worse than the missing extension.
 */
function check(name, fn, { gate = false } = {}) {
  if (blocked) {
    report('block', name, [`Not run — fix "${blocked}" first.`]);
    return null;
  }
  const outcome = fn();
  report(outcome.status, name, outcome.lines ?? []);
  if (outcome.status === 'fail' && gate) blocked = name;
  return outcome.value ?? null;
}

console.log('\nKiln doctor\n');

// ── 0. psql ──────────────────────────────────────────────────────────────────
check('psql is installed', () =>
  psqlAvailable()
    ? { status: 'pass' }
    : {
        status: 'fail',
        lines: [
          'Every database check below needs it.',
          '  macOS   brew install libpq && brew link --force libpq',
          '  Debian  sudo apt-get install postgresql-client',
          '',
          'Or skip it entirely: `pnpm db:bundle` produces a file you paste into the',
          'Supabase SQL editor in the browser. That path needs nothing installed.',
        ],
      },
  { gate: true },
);

// ── 1. DATABASE_URL ──────────────────────────────────────────────────────────
check('DATABASE_URL is set', () => {
  if (!url) {
    return {
      status: 'fail',
      lines: [
        'Not in the environment and not in .env.local.',
        '',
        'Get it from: dashboard → Project Settings → Database → Connection string.',
        'Choose **Session mode** (host ends .pooler.supabase.com, port 5432). Session mode',
        'is IPv4 and safe for schema changes; the direct db.<ref>.supabase.co host is',
        'IPv6-only on current projects, which is what breaks most laptops.',
        '',
        'Then: echo \'DATABASE_URL="postgresql://..."\' >> .env.local',
      ],
    };
  }

  const t = parseUrl(url);
  if (!t.ok) return { status: 'fail', lines: ['Set, but not a parseable URL.'] };

  const lines = [`${maskUrl(url)}`];

  // Not a failure — it connects. But it is the wrong endpoint for DDL and produces
  // errors later that look nothing like their cause.
  if (/pooler\.supabase\.com$/.test(t.host) && t.port === '6543') {
    lines.push(
      '',
      'Port 6543 is the TRANSACTION pooler — for application traffic, not migrations.',
      'Use Session mode (port 5432, same host) before pushing schema changes.',
    );
    return { status: 'warn', lines };
  }

  if (/^db\..*\.supabase\.co$/.test(t.host)) {
    lines.push(
      '',
      'This is the direct connection host, which is IPv6-only on current Supabase',
      'projects. If the next check fails with "network is unreachable", that is why —',
      'switch to the Session pooler string.',
    );
  }

  return { status: 'pass', lines };
}, { gate: true });

// ── 2. It connects ───────────────────────────────────────────────────────────
check('database is reachable', () => {
  const r = psql(url, ['-Atqc', 'select 1']);
  if (r.ok) {
    const version = scalar(url, 'show server_version') ?? '?';
    const who = scalar(url, 'select current_user') ?? '?';
    return { status: 'pass', lines: [`Postgres ${version}, connected as ${who}.`] };
  }

  const { cause, remedy } = classifyConnectionError(r.stderr, url);
  return {
    status: 'fail',
    lines: [
      cause,
      remedy,
      '',
      'psql said:',
      ...r.stderr.trim().split('\n').map((l) => `  ${l}`),
      '',
      'If this is the network rather than the credentials, stop here and use the browser:',
      '  pnpm db:bundle   → paste the file it writes into the Supabase SQL editor',
    ],
  };
}, { gate: true });

// ── 3. Vault ─────────────────────────────────────────────────────────────────
check('supabase_vault is available', () => {
  const installed = scalar(url, "select 1 from pg_extension where extname = 'supabase_vault'");
  if (installed === '1') {
    const readable = psql(url, ['-Atqc', 'select count(*) from vault.secrets']);
    return readable.ok
      ? { status: 'pass', lines: ['Extension present and vault.secrets is readable.'] }
      : {
          status: 'warn',
          lines: [
            'Extension present, but vault.secrets could not be read as this role.',
            'The app reads it through SECURITY DEFINER wrappers as service_role, so this',
            'may be fine — it is only a warning because it cannot be confirmed from here.',
          ],
        };
  }

  // Two very different situations, and calling both "not installed" is what makes this
  // check useless: on a hosted project it means one click was missed, and on a plain
  // Postgres it means this is not a Supabase database at all.
  const offered = scalar(
    url,
    "select 1 from pg_available_extensions where name = 'supabase_vault'",
  );

  if (offered !== '1') {
    return {
      status: 'warn',
      lines: [
        'The extension is not even available on this server, so this is a plain Postgres',
        'rather than a Supabase project. Expected locally — `scripts/verify-vault.mjs`',
        'stands in for it with matching signatures.',
        '',
        'Not expected if you meant to point at the hosted project. Check the host above.',
      ],
    };
  }

  return {
    status: 'fail',
    lines: [
      'Available but not enabled. Credentials entered in the wizard have nowhere to go —',
      'migration 0007 wraps it and the onboarding write path calls those wrappers.',
      '',
      '  dashboard → Database → Extensions → search "vault" → enable',
      '  or: create extension if not exists supabase_vault;',
    ],
  };
});

// ── 4. Migrations ────────────────────────────────────────────────────────────
const migrationState = check('migrations on disk are applied', () => {
  const onDisk = listMigrations();
  const hasLedger = ledgerExists(url);

  const applied = new Set(hasLedger ? (appliedVersions(url) ?? []) : []);
  const outstanding = onDisk.filter((m) => !applied.has(m.version));
  const unknown = [...applied].filter((v) => !onDisk.some((m) => m.version === v));

  const lines = hasLedger
    ? [`${applied.size} applied, ${onDisk.length} on disk.`]
    : [`No migration ledger yet. All ${onDisk.length} migrations count as outstanding.`];

  if (unknown.length > 0) {
    lines.push(
      '',
      `Recorded but not on disk: ${unknown.join(', ')}.`,
      'The database is ahead of this checkout — pull, or you are pointed at the wrong project.',
    );
  }

  if (outstanding.length > 0) {
    /**
     * Is the schema already ahead of the ledger?
     *
     * The case that needs saying out loud: someone pasted SQL into the editor, so the
     * objects exist while nothing recorded them. Re-running produces a wall of "already
     * exists" and the fix is the opposite of the usual one — record, do not run.
     *
     * Probed by asking whether the first outstanding migration's first created relation
     * is already there, rather than by the ledger's absence. A failed `db:push` creates
     * the ledger before it fails, so keying off "no ledger" missed this exact case the
     * first time it was tested against a database in that state.
     */
    const anchor = firstRelation(outstanding[0]);
    const present =
      anchor && scalar(url, `select to_regclass('public.${anchor}') is not null`) === 't';

    if (present) {
      lines.push(
        '',
        `But "${anchor}" already exists, and ${outstanding[0].version} is what creates it.`,
        'So the schema was applied outside this history — SQL pasted into the editor, usually.',
        '',
        'Do NOT re-run these; they will fail on "already exists". Work out how far the',
        'database actually got, then record those versions without running them:',
        `  pnpm db:push --baseline ${outstanding.map((m) => m.version).slice(0, 3).join(',')}...`,
        'and push whatever genuinely remains normally.',
      );
      return { status: 'fail', lines, value: { outstanding } };
    }

    lines.push(
      '',
      `Outstanding: ${outstanding.map((m) => m.version).join(', ')}`,
      ...outstanding.map((m) => `  ${m.file}`),
      '',
      `  pnpm db:push                     apply them here`,
      `  pnpm db:bundle --from ${outstanding[0].version}         or paste them in the browser`,
    );
    return { status: 'fail', lines, value: { outstanding } };
  }

  return {
    status: unknown.length > 0 ? 'warn' : 'pass',
    lines,
    value: { outstanding: [] },
  };
}, { gate: true });

// ── 5. Enums ─────────────────────────────────────────────────────────────────
check('enums match the CHECK constraints', () => {
  try {
    execFileSync('node', ['scripts/check-enums.mjs', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { status: 'pass' };
  } catch (err) {
    return {
      status: 'fail',
      lines: [
        'src/lib/db/enums.ts disagrees with the live constraints.',
        ...(err.stdout ?? '').trim().split('\n').filter(Boolean).map((l) => `  ${l}`),
        ...(err.stderr ?? '').trim().split('\n').filter(Boolean).map((l) => `  ${l}`),
      ],
    };
  }
});

// ── 6. check:catalog ─────────────────────────────────────────────────────────
//
// Needs a scratch database, because what it proves is that the migrations ALONE create
// the rows — with no seed to rescue them. Creating a database on someone's production
// project to prove a point about migrations is not a thing to do without being asked, so
// it runs only against a URL given for the purpose.
check('check:catalog (migrations create every catalogue row)', () => {
  const scratchUrl = process.env.SCRATCH_DATABASE_URL;
  if (!scratchUrl) {
    return {
      status: 'skip',
      lines: [
        'Needs a Postgres it may CREATE DATABASE on, and it will not do that to the',
        'target above. Set SCRATCH_DATABASE_URL to a local admin URL to run it here; CI',
        'runs it on every push regardless.',
        '',
        'The next check covers the same invariant against the real database — this one',
        'adds only that the rows come from a migration rather than having been inserted',
        'by hand.',
      ],
    };
  }

  try {
    execFileSync('node', ['scripts/check-catalog-rows.mjs', scratchUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { status: 'pass' };
  } catch (err) {
    return {
      status: 'fail',
      lines: (err.stdout ?? err.stderr ?? '').trim().split('\n').map((l) => `  ${l}`),
    };
  }
});

// ── 7. The rows the wizard cannot start without ──────────────────────────────
check('required rows are present', () => {
  const entries = catalogEntries();
  const rates = catalogRates();
  const breakers = breakerDrivers();
  const problems = [];
  const notes = [];

  const rows = (sql) => {
    const r = psql(url, ['-Atqc', sql]);
    return r.ok ? r.stdout.trim().split('\n').filter(Boolean) : null;
  };

  // integrations — the ones whose absence throws. `configureAndVerify` looks the row up
  // by slug and raises; it does not create it.
  const integrations = rows("select slug || '|' || kind from integrations");
  if (integrations === null) {
    problems.push('integrations — could not be read.');
  } else {
    const bySlug = new Map(integrations.map((l) => l.split('|')));
    for (const e of entries) {
      const kind = bySlug.get(e.slug);
      if (kind === undefined) {
        problems.push(
          `integrations — no row for "${e.slug}". The wizard step for it throws rather than creating one.`,
        );
      } else if (kind !== e.kind) {
        problems.push(`integrations — "${e.slug}" has kind '${kind}', the catalogue says '${e.kind}'.`);
      }
    }
    notes.push(`integrations   ${bySlug.size}/${entries.length}`);
  }

  // driver_health — nothing reads these yet; their absence is not a failure today.
  const health = rows('select driver from driver_health');
  if (health === null) {
    problems.push('driver_health — could not be read.');
  } else {
    const missing = breakers.filter((d) => !health.includes(d));
    if (missing.length > 0) {
      notes.push(
        `driver_health  missing ${missing.join(', ')} — no code reads this yet, so it is not`,
        '               breaking anything today. Migration 0014 creates them.',
      );
    } else {
      notes.push(`driver_health  ${health.length}/${breakers.length}`);
    }
  }

  // rate_card — a missing rate is not a crash. It is a refusal to spend, by design
  // (rule 5), so it is reported as fact rather than as a fault.
  //
  // `case when` rather than `is_verified::text`. A bare boolean column comes back from
  // psql -At as 't', but casting it to text inside a concatenation renders it as 'true' —
  // so comparing to 't' silently reports every verified rate as unverified. That exact
  // mistake already cost an hour during the stage 3 run; it is spelled out here rather
  // than left to be rediscovered.
  const rateRows = rows(
    "select driver || '|' || model || '|' || coalesce(endpoint,'') || '|' || unit || " +
      "'|' || case when is_verified then 'yes' else 'no' end from rate_card",
  );
  if (rateRows === null) {
    problems.push('rate_card — could not be read.');
  } else {
    const have = new Map(
      rateRows.map((l) => {
        const [driver, model, endpoint, unit, verified] = l.split('|');
        return [`${driver}|${model}|${endpoint}|${unit}`, verified === 'yes'];
      }),
    );
    const absent = rates.filter((r) => !have.has(`${r.driver}|${r.model}|${r.endpoint ?? ''}|${r.unit}`));
    const verified = rates.filter(
      (r) => have.get(`${r.driver}|${r.model}|${r.endpoint ?? ''}|${r.unit}`) === true,
    );

    // Both numbers, because they answer different questions and one alone misleads.
    // The catalogue declares only the credit- and character-priced calls, so a bare
    // "0 verified" reads as "nothing can be priced" while the published LLM token rates
    // from 0006 — the ones that let stage 3 actually run — sit outside that count.
    const totalVerified = [...have.values()].filter(Boolean).length;

    notes.push(
      `rate_card      ${rates.length - absent.length}/${rates.length} catalogue-declared rates present, ${verified.length} verified`,
      `               ${have.size} rows in the table overall, ${totalVerified} verified`,
    );
    if (absent.length > 0) {
      notes.push(`               absent: ${absent.map((r) => `${r.driver}/${r.model}`).join(', ')}`);
    }
    notes.push(
      '               Unverified is the correct state for anything priced in credits or',
      '               characters — nobody publishes those numbers, so they come off a real',
      '               invoice. Onboarding step 6 blocks on it deliberately, and a submit',
      '               that cannot be priced refuses. Neither is a fault.',
    );
  }

  if (problems.length > 0) {
    return {
      status: 'fail',
      lines: [
        ...problems.map((p) => `✗ ${p}`),
        '',
        'These come from migration 0014. If it is applied and rows are still missing,',
        'something deleted them — check you are pointed at the right project.',
        ...notes.map((n) => `  ${n}`),
      ],
    };
  }

  return { status: 'pass', lines: notes };
});

// ── Summary ──────────────────────────────────────────────────────────────────
const count = (s) => results.filter((r) => r.status === s).length;
const failed = count('fail');
const unrun = count('skip') + count('block');

console.log('─'.repeat(72));
console.log(
  `${count('pass')} passed · ${failed} failed · ${count('warn')} warned · ${unrun} not run\n`,
);

if (failed > 0) {
  const first = results.find((r) => r.status === 'fail');
  console.log(`Fix this one first: ${first.name}\n`);
  process.exit(1);
}

if (unrun > 0) {
  console.log('Everything that ran passed. See the skipped checks above for what was not proven.\n');
  process.exit(2);
}

const outstanding = migrationState?.outstanding ?? [];
console.log(
  outstanding.length === 0
    ? 'Database is ready. Walk the wizard.\n'
    : 'Checks pass, but migrations are outstanding — see above.\n',
);
