#!/usr/bin/env node
/**
 * Onboarding step 8 — First channel — against a real database.
 *
 * PROVES
 *   With the seeded Bureau channel present (0037), step 8 completes WITHOUT inserting: the
 *   channel count is unchanged, a blank handle leaves the handle alone, and an edited handle
 *   is written to that same row. Even a full "create" payload (name, platform, niche) cannot
 *   make a second channel while an active one exists — the rule is the function's, not the
 *   form's.
 *   With no active channel, the same call inserts exactly one row, and refuses a payload
 *   missing a field or naming a platform the schema does not allow, inserting nothing.
 *
 * DOES NOT PROVE
 *   The Server Action's session check or the page choosing which form to render; those need
 *   a signed-in browser. The action is a thin wrapper: `completeChannelStep` then
 *   `completeStep(8)`.
 *
 * Usage: node scripts/verify-onboarding.mjs <db-url>
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-onboarding.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { completeChannelStep, activeChannel } = require(`${BUILD}/onboarding/channel-step.js`);
const { BUREAU_CHANNEL_ID } = require(`${BUILD}/bureau/bible.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const check = (cond, label, detail = '') => {
  console[cond ? 'log' : 'error'](`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const scratch = await scratchDatabase(dbUrl, 'onboarding');
const client = scratch.client;
const db = supabaseShim(client);
const channels = async () => Number((await client.query('select count(*) n from channels')).rows[0].n);
const bureau = async () => (await client.query('select * from channels where id = $1', [BUREAU_CHANNEL_ID])).rows[0];

console.log('\nOnboarding step 8 — the first channel\n');

try {
  console.log('1. An active channel exists (the seeded Bureau channel)\n');
  // The hosted row's state on 06-Oct, reproduced.
  await client.query(`update channels set handle = '@BureauofReality', external_id = 'UCsAOylowJKXg7TENr5GskGQ' where id = $1`, [BUREAU_CHANNEL_ID]);
  const before = await channels();
  check(before >= 1 && (await bureau())?.is_active === true, 'the 0037 seed is present and active', `${before} channel(s)`);

  const found = await activeChannel(db, BUREAU_CHANNEL_ID);
  check(found?.id === BUREAU_CHANNEL_ID && found?.handle === '@BureauofReality', 'the step finds the Bureau channel to show', found?.name);

  const keep = await completeChannelStep(db, { name: '', platform: '', niche: '', handle: '' }, BUREAU_CHANNEL_ID);
  check(keep.ok && keep.inserted === false && keep.handleChanged === false, 'a blank submit completes without inserting');
  check((await channels()) === before, 'channel count unchanged', String(await channels()));
  check((await bureau()).handle === '@BureauofReality' && (await bureau()).external_id === 'UCsAOylowJKXg7TENr5GskGQ',
    'handle and external_id untouched');

  const edit = await completeChannelStep(db, { name: '', platform: '', niche: '', handle: 'BureauOfReality' }, BUREAU_CHANNEL_ID);
  check(edit.ok && edit.inserted === false && edit.handleChanged === true, 'an edited handle updates the row');
  check((await bureau()).handle === '@BureauOfReality', 'written to the Bureau row, with its @', (await bureau()).handle);
  check((await channels()) === before, 'still no new channel');

  const sneaky = await completeChannelStep(db, { name: 'Second', platform: 'youtube', niche: 'x', handle: '' }, BUREAU_CHANNEL_ID);
  check(sneaky.ok && sneaky.inserted === false && (await channels()) === before,
    'a full create payload still cannot make a second channel while one is active');

  const bad = await completeChannelStep(db, { name: '', platform: '', niche: '', handle: '@has space' }, BUREAU_CHANNEL_ID);
  check(!bad.ok && (await bureau()).handle === '@BureauOfReality', 'a malformed handle is refused and changes nothing', bad.message);

  console.log('\n2. No active channel\n');
  await client.query('update channels set is_active = false');
  check((await activeChannel(db, BUREAU_CHANNEL_ID)) === null, 'nothing active to show');
  const missing = await completeChannelStep(db, { name: 'Kiln', platform: 'youtube', niche: '', handle: '' }, BUREAU_CHANNEL_ID);
  check(!missing.ok && (await channels()) === before, 'a missing field is refused and inserts nothing', missing.message);
  const tiktok = await completeChannelStep(db, { name: 'Kiln', platform: 'tiktok', niche: 'ai', handle: '' }, BUREAU_CHANNEL_ID);
  check(!tiktok.ok && (await channels()) === before, 'a platform the schema refuses is refused here first', tiktok.message);
  const made = await completeChannelStep(db, { name: 'Kiln — main', platform: 'YouTube', niche: 'ai-tooling', handle: 'kiln' }, BUREAU_CHANNEL_ID);
  check(made.ok && made.inserted === true && (await channels()) === before + 1, 'a complete payload inserts exactly one channel');
  const row = (await client.query('select * from channels where id = $1', [made.channel.id])).rows[0];
  check(row.is_active === true && row.platform === 'youtube' && row.handle === '@kiln', 'active, platform lower-cased, handle with @');
  const again = await completeChannelStep(db, { name: 'Kiln — two', platform: 'youtube', niche: 'ai', handle: '' }, BUREAU_CHANNEL_ID);
  check(again.ok && again.inserted === false && again.channel.id === made.channel.id && (await channels()) === before + 1,
    'and running the step again uses it rather than making another');
} catch (err) {
  check(false, 'harness threw', err.stack ?? err.message);
} finally {
  await scratch.release();
}

console.log(failures === 0 ? '\nStep 8: all checks passed.\n' : `\nStep 8: ${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
