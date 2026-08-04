#!/usr/bin/env node
/**
 * Prove Supabase Vault works, end to end, against a real project.
 *
 * ⚠️  UNVERIFIED. This script has never been executed. The environment it was written in
 * has no network route to any Supabase host, so it is reasoned from the Vault API rather
 * than observed. Run it and paste the output; treat a first-run failure as a bug in this
 * file, not in your project.
 *
 * Every credential in the settings page ends up behind Vault, so "does Vault work" gates
 * the whole integrations design. Four checks, in order, each querying for expected state
 * rather than assuming the previous line succeeded:
 *
 *   1. the supabase_vault extension is installed
 *   2. vault.create_secret() returns an id
 *   3. vault.decrypted_secrets returns the *same plaintext* back
 *   4. deleting it actually removes the row
 *
 * Check 3 is the one that matters. An extension that installs and a function that returns
 * an id prove nothing about whether the value survives the round trip.
 *
 * If the extension is absent this script reports that and exits non-zero. It does not
 * enable it — turning on an extension is a deliberate act against a production database,
 * not something a verification script does on your behalf.
 *
 * Usage: node scripts/verify-vault.mjs [db-url]      (or set DATABASE_URL)
 *        The URL must be a direct Postgres connection to the hosted project:
 *        Dashboard → Settings → Database → Connection string → URI.
 */

import { tryConnect } from './lib/pg.mjs';

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-vault.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const connection = await tryConnect(dbUrl);
if (!connection.ok) {
  console.error(`could not connect: ${connection.error.message}\n`);
  console.error('Run `pnpm doctor` — it classifies connection failures rather than echoing them.');
  process.exit(2);
}
const client = connection.client;

/** First column of the first row, as a string, or '' when nothing came back. */
async function q(sql, params) {
  const r = await client.query(sql, params);
  if (r.rows.length === 0) return '';
  const v = Object.values(r.rows[0])[0];
  return v === null || v === undefined ? '' : String(v);
}

const name = `kiln_vault_probe_${process.pid}_${Date.now()}`;
const plaintext = `probe-value-${Math.random().toString(36).slice(2)}`;
let secretId = null;
let failed = 0;

function pass(label, detail) {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

console.log('Supabase Vault verification\n');

// ── 1. Extension present ─────────────────────────────────────────────────────
try {
  const version = await q("select extversion from pg_extension where extname = 'supabase_vault'");
  if (!version) {
    fail(
      'supabase_vault extension installed',
      'not found. Enable it in Dashboard → Database → Extensions, then re-run. ' +
        'This script will not enable it for you.',
    );
    process.exit(1);
  }
  pass('supabase_vault extension installed', `version ${version}`);
} catch (err) {
  fail('supabase_vault extension installed', `could not query pg_extension: ${err.message}`);
  process.exit(1);
}

// ── 2. Create ────────────────────────────────────────────────────────────────
try {
  secretId = await q(
    `select vault.create_secret('${plaintext}', '${name}', 'kiln verification probe')`,
  );
  if (!secretId) throw new Error('create_secret returned no id');
  pass('vault.create_secret()', `id ${secretId}`);
} catch (err) {
  fail('vault.create_secret()', err.message);
  process.exit(1);
}

// ── 3. Read back, and compare the plaintext ──────────────────────────────────
try {
  const got = await q(
    `select decrypted_secret from vault.decrypted_secrets where id = '${secretId}'`,
  );
  if (got === plaintext) {
    pass('vault.decrypted_secrets round trip', 'plaintext matches byte for byte');
  } else {
    fail(
      'vault.decrypted_secrets round trip',
      `expected ${plaintext.length} chars, got ${got.length}. The value did not survive ` +
        'encryption and decryption — do not store credentials until this is understood.',
    );
  }
} catch (err) {
  fail('vault.decrypted_secrets round trip', err.message);
}

// ── 4. Delete, and confirm it is gone ────────────────────────────────────────
try {
  // Bind parameters rather than interpolation. The id is ours, so this was never an
  // injection risk — but a probe that quotes its own values by hand is a poor advertisement
  // for a codebase whose rule is that external payloads are never trusted.
  await q('delete from vault.secrets where id = $1', [secretId]);
  const remaining = await q('select count(*) from vault.secrets where id = $1', [secretId]);
  // Number(), not === '0'. The old comparison worked by hard-coding the transport's
  // stringiness rather than coercing at the boundary — correct today, and silently
  // inverted the idiom every other harness uses. If the driver ever returns a real
  // number, '0' === 0 is false and the pass becomes a fail for the wrong reason.
  if (Number(remaining) === 0) {
    pass('delete removes the secret', 'row count is 0');
    secretId = null;
  } else {
    fail('delete removes the secret', `${remaining} row(s) still present`);
  }
} catch (err) {
  fail('delete removes the secret', err.message);
}

if (secretId) {
  console.error(`\nLEFTOVER: secret ${secretId} ("${name}") was not deleted. Remove it manually.`);
}

await client.end().catch(() => {});

console.log(
  failed === 0
    ? '\nVault works: created, read back identical plaintext, deleted.'
    : `\n${failed} check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
