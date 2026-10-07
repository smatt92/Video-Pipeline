#!/usr/bin/env node
/**
 * pnpm voice:lock <character> <preset> [--channel <slug>] — lock Sahil's audition pick.
 *
 * Since 0022 this writes the DATABASE bible (`channel_characters.voice`) through `lockVoice`,
 * the same action the app's Cast step calls: validated against the vendor's preset list,
 * recorded in authorship_log, read by the voice stage on its next run — no commit, no deploy.
 * It used to edit channels/<slug>/characters.json in place; that folder is now the import
 * source and the fallback, and editing it changes nothing for a channel whose bible is in the
 * database.
 *
 *   DATABASE_URL=… pnpm voice:lock pip Chad [--channel bureau-of-reality]
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { TTS_PRESET_IDS } = require(`${B}/drivers/voice-route.js`);
const { lockVoice } = require(`${B}/channels/bible-admin.js`);

const [character, preset] = process.argv.slice(2);
if (!character || !preset || character.startsWith('--')) {
  console.error('usage: pnpm voice:lock <character> <preset> [--channel <slug>]');
  process.exit(2);
}
if (!TTS_PRESET_IDS.includes(preset)) {
  console.error(`"${preset}" is not a known preset. Known: ${TTS_PRESET_IDS.join(', ')}`);
  process.exit(2);
}
const slug = process.argv.includes('--channel') ? process.argv[process.argv.indexOf('--channel') + 1] : 'bureau-of-reality';
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is required: the voice is locked in the database bible (0022). From the app: Channels → Cast → Lock voice.');
  process.exit(2);
}
const pg = (await import('pg')).default;
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const db = supabaseShim(client);
const [ch] = (await client.query('select id from channels where slug = $1', [slug])).rows;
if (!ch) {
  console.error(`No channel with slug ${slug}.`);
  process.exit(2);
}
const r = await lockVoice(db, { scope: 'approver', profileId: null, via: 'script:voice-lock' }, ch.id, { characterSlug: character, presetId: preset });
await client.end();
if (!r.ok) {
  console.error(r.refused.includes('no database bible') ? `${r.refused}\n  → node scripts/bible-import.mjs --channel ${slug} --db "$DATABASE_URL"` : r.refused);
  process.exit(1);
}
console.log(r.message);
