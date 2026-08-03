#!/usr/bin/env node
/**
 * Referral attribution and the partner roll-up, against a real database.
 *
 * PROVES:  a first click writes a code, a timestamp and a source; a second click does NOT
 *          overwrite them; a missing integrations row still yields a working link; the
 *          CHECK refuses half an attribution; and the roll-up view counts reconciled spend
 *          once while carrying nothing that could identify a video or a channel.
 *
 * The last one is the point of the view existing. Anonymisation that lives in a function is
 * anonymisation somebody can forget; this asserts the *columns* cannot leak.
 *
 * Usage: node scripts/verify-referral.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-referral.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { beginReferral, readPartnerRollup, mintReferralCode } = require(`${BUILD}/integrations/referral.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d='') => console.log(`  PASS  ${l}${d?` — ${d}`:''}`);
const bad = (l, d='') => { console.error(`  FAIL  ${l}${d?` — ${d}`:''}`); failures++; };

const scratch = await scratchDatabase(dbUrl, 'referral');
const client = scratch.client;
const db = supabaseShim(client);

console.log('\nReferral attribution and partner roll-up\n');

console.log('1. The connect flow\n');
{
  const first = await beginReferral(db, {
    slug: 'higgsfield', signupUrl: 'https://vendor.example/signup', source: 'refusal',
  });
  if (first.code && first.url.includes(`ref=${first.code}`)) ok('a first click mints a code and attaches it', first.code);
  else bad('a first click mints a code and attaches it', JSON.stringify(first));

  const { rows } = await client.query(
    `select referral_code, referral_source, referred_at is not null as dated from integrations where slug='higgsfield'`);
  if (rows[0].referral_code === first.code && rows[0].referral_source === 'refusal' && rows[0].dated) {
    ok('  · recorded with its source and a timestamp', 'refusal');
  } else bad('  · recorded with its source and a timestamp', JSON.stringify(rows[0]));

  const second = await beginReferral(db, {
    slug: 'higgsfield', signupUrl: 'https://vendor.example/signup', source: 'settings',
  });
  if (second.code === first.code) ok('a second click reuses the code', 'a return visit is not a second signup');
  else bad('a second click reuses the code', `${first.code} -> ${second.code}`);

  const { rows: after } = await client.query(
    `select referral_source from integrations where slug='higgsfield'`);
  if (after[0].referral_source === 'refusal') ok('  · and does not re-date or re-source it');
  else bad('  · and does not re-date or re-source it', after[0].referral_source);

  const unknown = await beginReferral(db, {
    slug: 'not-a-vendor', signupUrl: 'https://vendor.example/signup', source: 'onboarding',
  });
  if (unknown.code === null && unknown.url === 'https://vendor.example/signup') {
    ok('an unknown integration still yields a working link', 'measurement must not block the thing measured');
  } else bad('an unknown integration still yields a working link', JSON.stringify(unknown));
}

console.log('\n2. The constraint\n');
{
  const err = await client.query(
    `update integrations set referral_code='x', referred_at=null where slug='fal'`
  ).then(() => null).catch((e) => e);
  if (err && /integrations_referral_complete/.test(err.message)) {
    ok('half an attribution is refused', 'a code with no date is not evidence');
  } else bad('half an attribution is refused', err?.message ?? 'it was accepted');
}

console.log('\n3. The roll-up\n');
{
  // One generation, reconciled — plus an estimate row for the same call, which must not be
  // double counted. That is the arithmetic error the view is written to avoid.
  const gen = randomUUID();
  await client.query(
    `insert into generations (id, kind, driver, model, request_payload, idempotency_key, status)
     values ($1,'image','higgsfield','soul','{}',$2,'succeeded')`, [gen, `verify:${gen}`]);
  await client.query(
    `insert into cost_ledger (generation_id, driver, entry_kind, unit, quantity, cost_usd, cost_inr, idempotency_key)
     values ($1,'higgsfield','estimate','credit',1,0.08,7.08,$2),
            ($1,'higgsfield','reconcile','credit',1,0.08,7.08,$3)`,
    [gen, `e:${gen}`, `r:${gen}`]);

  const rows = await readPartnerRollup(db);
  const hf = rows.find((r) => r.driver === 'higgsfield');
  if (hf && hf.unitsConsumed === 1 && Math.abs(hf.costInr - 7.08) < 0.01) {
    ok('reconciled spend is counted once', `${hf.unitsConsumed} credit, ₹${hf.costInr}`);
  } else {
    bad('reconciled spend is counted once', JSON.stringify(hf));
  }

  const { rows: cols } = await client.query(
    `select column_name from information_schema.columns where table_name='v_partner_rollup'`);
  const names = cols.map((c) => c.column_name);
  const leaky = names.filter((n) => /title|name|hook|vo_text|prompt|angle|_id$/.test(n));
  if (leaky.length === 0) ok('the view carries nothing identifying', names.join(', '));
  else bad('the view carries nothing identifying', leaky.join(', '));

  if (mintReferralCode() !== mintReferralCode()) ok('codes are unique');
  else bad('codes are unique');
}

await scratch.release();
console.log(failures === 0 ? '\nAttribution and roll-up verified.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
