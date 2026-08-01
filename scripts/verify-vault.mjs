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

import { execFileSync } from 'node:child_process';

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-vault.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

function q(sql) {
  return execFileSync('psql', [dbUrl, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
  const version = q("select extversion from pg_extension where extname = 'supabase_vault'");
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
  secretId = q(
    `select vault.create_secret('${plaintext}', '${name}', 'kiln verification probe')`,
  );
  if (!secretId) throw new Error('create_secret returned no id');
  pass('vault.create_secret()', `id ${secretId}`);
} catch (err) {
  fail('vault.create_secret()', err.stderr?.trim() ?? err.message);
  process.exit(1);
}

// ── 3. Read back, and compare the plaintext ──────────────────────────────────
try {
  const got = q(
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
  fail('vault.decrypted_secrets round trip', err.stderr?.trim() ?? err.message);
}

// ── 4. Delete, and confirm it is gone ────────────────────────────────────────
try {
  q(`delete from vault.secrets where id = '${secretId}'`);
  const remaining = q(`select count(*) from vault.secrets where id = '${secretId}'`);
  if (remaining === '0') {
    pass('delete removes the secret', 'row count is 0');
    secretId = null;
  } else {
    fail('delete removes the secret', `${remaining} row(s) still present`);
  }
} catch (err) {
  fail('delete removes the secret', err.stderr?.trim() ?? err.message);
}

if (secretId) {
  console.error(`\nLEFTOVER: secret ${secretId} ("${name}") was not deleted. Remove it manually.`);
}

console.log(
  failed === 0
    ? '\nVault works: created, read back identical plaintext, deleted.'
    : `\n${failed} check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
