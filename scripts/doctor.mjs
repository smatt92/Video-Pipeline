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
  describeEffects,
  listMigrations,
  migrationEffects,
  maskUrl,
  parseUrl,
  wrap,
} from './lib/migrations.mjs';

const url = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.DATABASE_URL;

const results = [];
let blocked = null;

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
async function check(name, fn, { gate = false, independent = false } = {}) {
  // `independent: true` means no gate above can entail this one's result — it does not
  // touch the database at all. Without it the worker-environment check reported BLOCKED
  // behind "DATABASE_URL is set", which is this file's own documented bug wearing a new
  // hat: an answer it could give perfectly well, withheld because something unrelated
  // failed first. `gate` and `independent` are different axes — one is "can I entail
  // others", the other is "can others entail me".
  if (blocked && !independent) {
    report('block', name, [`Not run — fix "${blocked}" first.`]);
    return null;
  }
  const outcome = await fn();
  report(outcome.status, name, outcome.lines ?? []);
  if (outcome.status === 'fail' && gate) blocked = name;
  return outcome.value ?? null;
}

console.log('\nKiln doctor\n');

// ── 0. Dependencies ──────────────────────────────────────────────────────────
//
// Imported dynamically so a missing install is a sentence rather than a stack trace from
// the module loader before any output appears. `pg` is a devDependency; the app never
// imports it.
let pgLib = null;
await check(
  'database client is installed',
  async () => {
    try {
      pgLib = await import('./lib/pg.mjs');
      return { status: 'pass' };
    } catch (err) {
      return {
        status: 'fail',
        lines: [
          'Could not load `pg`. Run `pnpm install`.',
          '',
          'Or skip it entirely: `pnpm db:bundle` writes a file you paste into the Supabase',
          'SQL editor, and imports nothing from node_modules by design.',
          '',
          `  ${err.message}`,
        ],
      };
    }
  },
  { gate: true },
);

// ── 1. DATABASE_URL ──────────────────────────────────────────────────────────
await check(
  'DATABASE_URL is set',
  () => {
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
        'projects. If the next check fails with "no route to host", that is why —',
        'switch to the Session pooler string.',
      );
    }

    return { status: 'pass', lines };
  },
  { gate: true },
);

// ── 2. It connects ───────────────────────────────────────────────────────────
//
// One connection, held for every check below. Opening one per check would multiply the
// wait on a slow link and give five chances to fail differently.
let client = null;

await check(
  'database is reachable',
  async () => {
    const attempt = await pgLib.tryConnect(url);
    if (attempt.ok) {
      client = attempt.client;
      const version = await pgLib.scalar(client, 'show server_version');
      const who = await pgLib.scalar(client, 'select current_user');
      const ssl = await pgLib.scalar(
        client,
        'select ssl from pg_stat_ssl where pid = pg_backend_pid()',
      );
      return {
        status: 'pass',
        lines: [`Postgres ${version}, connected as ${who}, TLS ${ssl ? 'on' : 'off'}.`],
      };
    }

    const { cause, remedy } = pgLib.classifyConnectionError(attempt.error, url);
    return {
      status: 'fail',
      lines: [
        cause,
        remedy,
        '',
        'The client said:',
        `  ${attempt.error.message}`,
        '',
        'If this is the network rather than the credentials, stop here and use the browser:',
        '  pnpm db:bundle   → paste the file it writes into the Supabase SQL editor',
      ],
    };
  },
  { gate: true },
);

try {
  // ── 2b. Which database is this, actually? ──────────────────────────────────
  //
  // Added after a diagnosis that took four queries to establish something this should have
  // said in one line. The project had four Supabase projects, one active; the app had been
  // signed into it; and its `public` schema was completely empty. Two different diagnoses
  // had been offered — "the migrations are half-applied" and "the data is gone" — and
  // neither was right: nothing had ever been applied, so there had never been a table to
  // hold data.
  //
  // What distinguishes those three cases is not the migration ledger. It is the
  // combination below:
  //
  //   relations 0, auth users 0  → almost certainly the wrong project, or a brand new one
  //   relations 0, auth users >0 → the right project, never migrated. THIS is the case
  //                                that reads as "my data is gone" and is not.
  //   relations >0, ledger empty → someone pasted SQL without recording it (see the
  //                                migration check below, which probes for exactly that)
  //
  // Printed as facts rather than as a verdict, because the verdict depends on what the
  // operator expected to be here and this script does not know that.
  await check('which database this is', async () => {
    const target = parseUrl(url);
    const host = target.host ?? '(unknown)';

    // Supabase hostnames carry the project ref two different ways, and both are worth
    // resolving: a direct connection puts it in the hostname, and a pooler connection puts
    // it in the *username* as `postgres.<ref>`. Someone comparing the wrong one against
    // their dashboard is exactly how you end up measuring a database you did not mean to.
    const ref =
      /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host)?.[1] ??
      (/\.pooler\.supabase\.com$/.test(host) ? (target.user ?? '').split('.')[1] : null) ??
      null;

    const relations = await pgLib.scalar(
      client,
      "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v')",
    );

    // Both are Supabase-managed schemas, absent on a plain Postgres. Queried defensively so
    // this check still works against the local databases the harnesses use.
    const authUsers = await pgLib
      .scalar(client, 'select count(*) from auth.users')
      .catch(() => null);
    const buckets = await pgLib
      .scalar(client, 'select count(*) from storage.buckets')
      .catch(() => null);

    const lines = [
      `host ${host}${ref ? `  project ${ref}` : ''}`,
      `public: ${relations} tables and views`,
    ];

    if (authUsers !== null) {
      lines.push(`auth users: ${authUsers}   storage buckets: ${buckets ?? 0}`);
    }

    // The one inference worth making, because it is the one people get wrong.
    if (Number(relations) === 0 && authUsers !== null && Number(authUsers) > 0) {
      lines.push(
        '',
        'Signed-in users exist and the schema is empty.',
        'That is a database nothing was ever migrated into —',
        'not one that lost its data. There was never a table here.',
      );
    } else if (Number(relations) === 0 && (authUsers === null || Number(authUsers) === 0)) {
      lines.push(
        '',
        'Empty schema and no signed-in users. Either a fresh',
        'project, or not the one the app has been talking to.',
        'Check the ref above against your deployment.',
      );
    }

    return { status: 'pass', lines };
  });

  // ── 3. Vault ───────────────────────────────────────────────────────────────
  await check('supabase_vault is available', async () => {
    const installed = await pgLib.scalar(
      client,
      "select count(*) from pg_extension where extname = 'supabase_vault'",
    );

    if (Number(installed) > 0) {
      try {
        await client.query('select count(*) from vault.secrets');
        return { status: 'pass', lines: ['Extension present and vault.secrets is readable.'] };
      } catch {
        return {
          status: 'warn',
          lines: [
            'Extension present, but vault.secrets could not be read as this role.',
            'The app reads it through SECURITY DEFINER wrappers as service_role, so this',
            'may be fine — it is only a warning because it cannot be confirmed from here.',
          ],
        };
      }
    }

    // Two very different situations, and calling both "not installed" is what makes this
    // check useless: on a hosted project it means one click was missed, and on a plain
    // Postgres it means this is not a Supabase database at all.
    const offered = await pgLib.scalar(
      client,
      "select count(*) from pg_available_extensions where name = 'supabase_vault'",
    );

    if (Number(offered) === 0) {
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

  // ── 4. Migrations ──────────────────────────────────────────────────────────
  await check(
    'migrations on disk are applied',
    async () => {
      const onDisk = listMigrations();
      const hasLedger = await pgLib.ledgerExists(client);

      const applied = new Set(hasLedger ? ((await pgLib.appliedVersions(client)) ?? []) : []);
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
         * Someone pasted SQL into the editor, so the objects exist while nothing recorded
         * them. Re-running produces a wall of "already exists" and the fix is the opposite
         * of the usual one — record, do not run.
         *
         * Probed by asking whether each outstanding migration's own objects are already
         * there, rather than by the ledger's absence. A failed `db:push` creates the
         * ledger before it fails, so keying off "no ledger" missed this exact case.
         */
        lines.push('', `Outstanding: ${outstanding.map((m) => m.version).join(', ')}`, '');

        let anyAlreadyPresent = false;

        for (const m of outstanding) {
          const effects = migrationEffects(m);
          lines.push(`  ${m.file}`);
          for (const line of describeEffects(effects)) lines.push(`    ${line}`);

          // Does its work appear to be done already?
          let present = null;
          if (effects.anchor) {
            present =
              (await pgLib.scalar(client, 'select to_regclass($1) is not null', [
                `public.${effects.anchor}`,
              ])) === true;
          } else if (effects.anchorColumn) {
            const [table, column] = effects.anchorColumn.split('.');
            present =
              Number(
                await pgLib.scalar(
                  client,
                  'select count(*) from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3',
                  ['public', table, column],
                ),
              ) > 0;
          } else if (effects.inserts.length) {
            // Insert-only, so there is no object to look for. Report what the table holds
            // now — the number that answers "is this why my screen is empty?".
            for (const i of effects.inserts) {
              const n = await pgLib
                .scalar(client, `select count(*) from ${i.table}`)
                .catch(() => null);
              lines.push(`    ${i.table} currently holds ${n ?? '?'} row(s)`);
            }
          }

          if (present === true) {
            anyAlreadyPresent = true;
            lines.push(
              `    ⚠ its objects ALREADY EXIST — the schema ran but the ledger did not record it`,
            );
          }
          lines.push('');
        }

        if (anyAlreadyPresent) {
          lines.push(
            'At least one outstanding migration has already been applied to the schema',
            'without being recorded. That is what pasting a bundle whose ledger inserts were',
            'skipped looks like. Re-running it will fail on "already exists".',
            '',
            'Record those without running them, then apply whatever genuinely remains:',
            `  pnpm db:push --baseline ${outstanding.map((m) => m.version).join(',')}`,
            '',
            'Confirm each one against this list first — baselining a migration that did not',
            'run leaves a database claiming to be somewhere it is not.',
          );
        } else {
          lines.push(
            'To get current — pull first, then either:',
            '',
            `  pnpm db:bundle --from ${outstanding[0].version}`,
            '     writes one file; paste it into the Supabase SQL editor and run it',
            '',
            '  pnpm db:push',
            '     applies them directly, if the database is reachable from here',
            '',
            'A bundle generated before these migrations existed cannot contain them.',
            'Regenerate rather than reuse — db:bundle is offline and costs nothing.',
          );
        }

        return { status: 'fail', lines, value: { outstanding } };
      }

      return {
        status: unknown.length > 0 ? 'warn' : 'pass',
        lines,
        value: { outstanding: [] },
      };
    },
    { gate: true },
  );

  // ── 4b. PostgREST's view of the schema ─────────────────────────────────────
  //
  // The check that distinguishes the two failures that read identically.
  //
  // Supabase serves the app through PostgREST, which holds the schema in memory. Applying
  // migrations by pasting SQL into the editor changes the database and does NOT tell
  // PostgREST to reload — so every table exists, `information_schema` lists them, psql
  // sees them, and the app still says "Could not find the table 'public.X' in the schema
  // cache". Reading that message, "the migration did not run" and "the cache is stale" are
  // indistinguishable, and they have opposite fixes.
  //
  // So this asks the database and PostgREST the same question and compares the answers.
  await check('PostgREST sees the schema', async () => {
    const restUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
    const key =
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!restUrl || !key) {
      return {
        status: 'skip',
        lines: [
          'Needs NEXT_PUBLIC_SUPABASE_URL and a key in the environment (.env.local is read).',
          'Without them this cannot tell a stale cache from a missing table, and those are',
          'the two failures that read identically.',
        ],
      };
    }

    // Tables the app cannot start without, one per migration era, so a partial apply is
    // visible as a partial answer rather than a single yes/no.
    const probes = ['profiles', 'integrations', 'concepts', 'v_deferred_steps'];
    const missingInRest = [];
    const missingInDb = [];

    for (const table of probes) {
      const inDb =
        (await pgLib.scalar(client, 'select to_regclass($1) is not null', [`public.${table}`])) ===
        true;
      if (!inDb) {
        missingInDb.push(table);
        continue;
      }

      // head + limit 0: asks PostgREST to resolve the name without transferring rows.
      let seen = false;
      try {
        const response = await fetch(`${restUrl}/rest/v1/${table}?select=*&limit=0`, {
          headers: { apikey: key, authorization: `Bearer ${key}` },
        });
        seen = response.ok;
      } catch {
        seen = false;
      }
      if (!seen) missingInRest.push(table);
    }

    if (missingInDb.length > 0) {
      return {
        status: 'fail',
        lines: [
          `Absent from the DATABASE: ${missingInDb.join(', ')}.`,
          'The migrations have not been applied. This is not a cache problem — see the',
          'migration check above for what to run.',
        ],
      };
    }

    if (missingInRest.length > 0) {
      return {
        status: 'fail',
        lines: [
          `${missingInRest.join(', ')} exist in the database but PostgREST cannot see them.`,
          '',
          '**This is a stale schema cache, not a missing migration.** The tables are there;',
          'the API layer has not been told. Run this in the SQL editor:',
          '',
          "  notify pgrst, 'reload schema';",
          '',
          'Then re-run this check. Bundles generated from now on end with that statement, so',
          'a fresh paste reloads the cache on its own — this only bites a bundle pasted',
          'before that was added.',
        ],
      };
    }

    return {
      status: 'pass',
      lines: [`PostgREST resolves all ${probes.length} probe relations.`],
    };
  });

  // ── 5. Enums ───────────────────────────────────────────────────────────────
  //
  // Shells out to the real check rather than reimplementing it. Doctor should report what
  // `pnpm check:enums` says, not a second opinion that can drift from it.
  await check('enums match the CHECK constraints', () => {
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

  // ── 6. check:catalog ───────────────────────────────────────────────────────
  //
  // Needs a scratch database, because what it proves is that the migrations ALONE create
  // the rows — with no seed to rescue them. Creating a database on someone's production
  // project to prove a point about migrations is not a thing to do without being asked,
  // so it runs only against a URL given for the purpose.
  await check('check:catalog (migrations create every catalogue row)', () => {
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

  // ── 7. The rows the wizard cannot start without ────────────────────────────
  await check('required rows are present', async () => {
    const entries = catalogEntries();
    const rates = catalogRates();
    const breakers = breakerDrivers();
    const problems = [];
    const notes = [];

    const read = async (sql) => {
      try {
        return await pgLib.rows(client, sql);
      } catch {
        return null;
      }
    };

    // integrations — the ones whose absence throws. `configureAndVerify` looks the row up
    // by slug and raises; it does not create it.
    const integrations = await read('select slug, kind from integrations');
    if (integrations === null) {
      problems.push('integrations — could not be read.');
    } else {
      const bySlug = new Map(integrations.map((r) => [r.slug, r.kind]));
      for (const e of entries) {
        const kind = bySlug.get(e.slug);
        if (kind === undefined) {
          problems.push(
            `integrations — no row for "${e.slug}". The wizard step for it throws rather than creating one.`,
          );
        } else if (kind !== e.kind) {
          problems.push(
            `integrations — "${e.slug}" has kind '${kind}', the catalogue says '${e.kind}'.`,
          );
        }
      }
      notes.push(`integrations   ${bySlug.size}/${entries.length}`);
    }

    // driver_health — nothing reads these yet; their absence is not a failure today.
    const health = await read('select driver from driver_health');
    if (health === null) {
      problems.push('driver_health — could not be read.');
    } else {
      const drivers = health.map((r) => r.driver);
      const missing = breakers.filter((d) => !drivers.includes(d));
      if (missing.length > 0) {
        notes.push(
          `driver_health  missing ${missing.join(', ')} — no code reads this yet, so it is not`,
          '               breaking anything today. Migration 0014 creates them.',
        );
      } else {
        notes.push(`driver_health  ${drivers.length}/${breakers.length}`);
      }
    }

    // rate_card — a missing rate is not a crash. It is a refusal to spend, by design
    // (rule 5), so it is reported as fact rather than as a fault.
    //
    // Typed columns straight from the driver: `is_verified` arrives as a JavaScript
    // boolean. The psql version of this concatenated it into text, where a bare boolean
    // renders as 't' but a ::text cast renders as 'true' — comparing to the wrong one
    // silently reported every verified rate as unverified, and cost an hour during the
    // stage 3 run. That whole class of mistake is gone with a real client.
    const rateRows = await read('select driver, model, endpoint, unit, is_verified from rate_card');
    if (rateRows === null) {
      problems.push('rate_card — could not be read.');
    } else {
      const key = (r) => `${r.driver}|${r.model}|${r.endpoint ?? ''}|${r.unit}`;
      const have = new Map(rateRows.map((r) => [key(r), r.is_verified === true]));

      const absent = rates.filter((r) => !have.has(key(r)));
      const verified = rates.filter((r) => have.get(key(r)) === true);

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
} finally {
  await client?.end().catch(() => {});
}

// ── The worker's environment ─────────────────────────────────────────────────
//
// Deliberately outside the database block: it needs no connection, and it is the one check
// here about the *other* deployment target. `check:trigger-env` proves the manifest matches
// the code and explicitly cannot see any environment; this asks the same list of the
// environment it can see, which is the half that answers "why did the run fail".
//
// Reported as a warning rather than a failure. A local shell legitimately lacks the
// worker's variables — that is not a broken machine, and making it fail would train
// everyone to ignore a red line that is usually wrong.
await check('the worker has the variables its manifest names', async () => {
  let manifest;
  try {
    const mod = await import('./lib/worker-env.mjs');
    manifest = await mod.readManifest();
  } catch (err) {
    return {
      status: 'warn',
      lines: [`Could not read the worker env manifest: ${err.message}`],
    };
  }

  const missing = manifest
    .filter((v) => v.required)
    .filter((v) => {
      const value = process.env[v.name];
      return value === undefined || value.trim() === '';
    })
    .map((v) => v.name);

  if (missing.length === 0) {
    return {
      status: 'pass',
      lines: [
        `All ${manifest.filter((v) => v.required).length} required worker variables are set here.`,
        '',
        'This machine, not the Trigger.dev environment — nothing local can see that one. ' +
          'Run `pnpm check:trigger-env` for the list to paste into its dashboard.',
      ],
    };
  }

  return {
    status: 'warn',
    lines: [
      `${missing.length} variable(s) the worker's manifest calls required are unset here:`,
      `    ${missing.join(', ')}`,
      '',
      'Fine on a machine that never runs a task. Not fine in the Trigger.dev environment: ' +
        'a deploy missing any of these produces a run that fails naming a variable rather ' +
        'than the configuration step that omitted it — after a generation has been paid ' +
        'for. `pnpm check:trigger-env` prints each one with what breaks without it.',
    ],
  };
}, { independent: true });

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

console.log('Database is ready. Walk the wizard.\n');
