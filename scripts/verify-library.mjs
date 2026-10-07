#!/usr/bin/env node
/**
 * The Library screens and Concepts — Voices, Prompts, Music — against real Postgres.
 *
 * PROVES:  with no override, the route the Voices lib reports equals the preset in
 *          channels/bureau-of-reality/characters.json, read here from disk; a character with no
 *          locked preset is reported refused with the router's own reason; after
 *          `setVoiceOverride` the reported route is the override AND what the voice stage reads
 *          (`voiceOverrides` + `routeForCharacter`) agrees; an override on channel B does not
 *          reach channel A's map or route; clearing falls back to the bible; an invalid preset,
 *          an unknown provider and a slug outside the cast are refused by name and write no row;
 *          the latest take is the newest one for that speaker on THIS channel; a recipe with no
 *          watched sample cannot be reinstated (and stays retired), one given a URL can; a
 *          recipe's rate is the 0044 rate-card figure, and an unknown model says "unpriced" with
 *          the lookup's reason; a music confirm refuses a bed outside the pool, a non-audio type
 *          and an oversize file, writing nothing, and records the server-built key otherwise; a
 *          series default refuses a bed that is not uploaded and a series the channel does not
 *          run; the concepts list for A excludes B's concept, and its cost columns are exactly
 *          the sums of the ledger rows inserted here (computed from the literals, not read back);
 *          the detail page's channel test refuses B's concept; and with 0046's tables dropped,
 *          both screens still render, say "needs migration 0046", and writes refuse by name.
 *
 * DOES NOT: render a page, PUT to a bucket, or presign anything — the browser half of the
 *           upload and the <audio> players are unexercised here.
 *
 * Usage: node scripts/verify-library.mjs <db-url>
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-library.mjs <db-url>');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { bibleForSlug, voiceOverrides, routeForCharacter } = require(`${BUILD}/bureau/bible.js`);
const { VOICE_PROVIDERS, voiceKey } = require(`${BUILD}/drivers/voice-route.js`);
const { voicesScreen, setVoiceOverride, clearVoiceOverride } = require(`${BUILD}/library/voices.js`);
const { musicScreen, confirmBedUpload, setSeriesDefault, MUSIC_MAX_BYTES } = require(`${BUILD}/library/music.js`);
const { listConcepts, conceptOnChannel } = require(`${BUILD}/concepts/by-channel.js`);
const { reinstateRecipe, recipeRate } = require(`${BUILD}/prompts/library.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};
const check = (cond, l, d = '') => (cond ? ok(l, d) : bad(l, d));

const scratch = await scratchDatabase(dbUrl, 'library');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

// Channel A: the Bureau, seeded by 0037, bible folder in this build. Channel B: no slug, so no
// bible — the override written for it uses A's cast only to get past the slug check.
const A = 'b0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-0000000000b3';
await q(`insert into channels (id, name, platform, niche, is_active, slug) values ($1, 'Harness B', 'youtube', 'harness', true, null)`, [B]);
const cb = bibleForSlug('bureau-of-reality');

// The independent route for "what the bible says": the JSON on disk, not the bible module.
const disk = JSON.parse(readFileSync(new URL('../channels/bureau-of-reality/characters.json', import.meta.url), 'utf8'));
const diskPreset = (slug) => disk.characters.find((c) => c.id === slug).voice.preset_id;
const PROVIDER = VOICE_PROVIDERS[0];

const rowFor = async (channel, slug) => (await voicesScreen(db, channel, cb)).rows.find((r) => r.slug === slug);
const stageRoute = async (channel, slug) => routeForCharacter(cb, slug, await voiceOverrides(db, channel));
const overrideRows = async (channel, slug) =>
  Number((await q(`select count(*)::int as n from channel_voice_overrides where channel_id = $1 and character_slug = $2`, [channel, slug]))[0].n);

console.log('\nLibrary — voices, prompts, music, concepts\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. No override: the bible decides\n');
{
  const pip = await rowFor(A, 'pip');
  check(diskPreset('pip') === 'Chad', 'precondition: the disk bible locks pip to Chad', diskPreset('pip'));
  check(pip.route.ok === true && pip.route.voiceId === diskPreset('pip') && pip.source === 'bible', "pip's reported route is the disk preset, from the bible", JSON.stringify(pip.route));
  const iyer = await rowFor(A, 'iyer');
  check(diskPreset('iyer') === null, 'precondition: iyer has no locked preset on disk');
  check(
    iyer.route.ok === false && iyer.route.code === 'voice_not_locked' && iyer.route.detail.startsWith('Mrs. Iyer has no locked preset.'),
    'iyer is reported refused, with the router’s reason',
    iyer.route.detail,
  );
  check(pip.take === null, 'no take stored yet is null, not a broken URL');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. An override wins, and the voice stage reads the same\n');
{
  const r = await setVoiceOverride(db, { channelId: A, cb, setBy: null, input: { slug: 'pip', provider: PROVIDER, voiceId: 'Maya', note: 'harness' } });
  check(r.ok === true, 'setVoiceOverride accepts a preset', r.ok ? r.message : r.problem);
  const pip = await rowFor(A, 'pip');
  check(pip.route.ok && pip.route.voiceId === 'Maya' && pip.source === 'override', 'the reported route is the override', JSON.stringify(pip.route));
  const stage = await stageRoute(A, 'pip');
  check(stage.ok && voiceKey(stage) === `${PROVIDER}:Maya`, 'voiceOverrides + routeForCharacter (the stage) give the same voice', stage.ok ? voiceKey(stage) : stage.detail);
  check(pip.override?.note === 'harness', 'the note is kept', pip.override?.note);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. Refusals write nothing\n');
{
  const bad1 = await setVoiceOverride(db, { channelId: A, cb, setBy: null, input: { slug: 'iyer', provider: PROVIDER, voiceId: 'NotAPreset' } });
  check(!bad1.ok && bad1.problem === 'Not saved: "NotAPreset" is not a preset the voice vendor offers.', 'an invalid preset is refused by name', bad1.ok ? 'accepted' : bad1.problem);
  check((await overrideRows(A, 'iyer')) === 0, '  · and no row was written for iyer');

  const bad2 = await setVoiceOverride(db, { channelId: A, cb, setBy: null, input: { slug: 'iyer', provider: 'nobody', voiceId: 'x' } });
  check(!bad2.ok && bad2.problem === 'Not saved: unknown voice provider "nobody".', 'an unknown provider is refused by name', bad2.ok ? 'accepted' : bad2.problem);

  const bad3 = await setVoiceOverride(db, { channelId: A, cb, setBy: null, input: { slug: 'nobody', provider: PROVIDER, voiceId: 'Maya' } });
  check(!bad3.ok && bad3.problem === 'Not saved: "nobody" is not in the bureau-of-reality cast.', 'a slug outside the cast is refused by name', bad3.ok ? 'accepted' : bad3.problem);
  check((await overrideRows(A, 'nobody')) === 0, '  · and wrote nothing');
  check(((await stageRoute(A, 'iyer')).ok) === false, 'iyer is still refused by the stage after the refusals');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n4. Channel B's override stays on channel B\n");
{
  const r = await setVoiceOverride(db, { channelId: B, cb, setBy: null, input: { slug: 'pip', provider: PROVIDER, voiceId: 'Rachel' } });
  check(r.ok === true, 'B sets pip to Rachel', r.ok ? '' : r.problem);
  const mapA = await voiceOverrides(db, A);
  const mapB = await voiceOverrides(db, B);
  check(mapA.get('pip')?.voiceId === 'Maya' && mapA.size === 1, "A's map still holds only its own Maya", JSON.stringify([...mapA]));
  check(mapB.get('pip')?.voiceId === 'Rachel', "B's map holds Rachel");
  const pip = await rowFor(A, 'pip');
  check(pip.route.ok && pip.route.voiceId === 'Maya', "A's reported route is unchanged", pip.route.ok ? pip.route.voiceId : pip.route.detail);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. Clearing falls back to the bible\n');
{
  const r = await clearVoiceOverride(db, { channelId: A, cb, slug: 'pip' });
  check(r.ok && r.message === "Pip falls back to the bible's voice.", 'clear reports the fallback', r.ok ? r.message : r.problem);
  const pip = await rowFor(A, 'pip');
  check(pip.route.ok && pip.route.voiceId === diskPreset('pip') && pip.source === 'bible' && pip.override === null, 'the route is the disk preset again', JSON.stringify(pip.route));
  const stage = await stageRoute(A, 'pip');
  check(stage.ok && stage.voiceId === diskPreset('pip'), 'and so is what the stage reads');
  check((await overrideRows(B, 'pip')) === 1, "B's override survived A's clear");
  const again = await clearVoiceOverride(db, { channelId: A, cb, slug: 'pip' });
  check(again.ok && again.message === "Pip had no override; the bible's voice already applies.", 'clearing an absent override says so');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. The last take is the newest for that speaker, on this channel\n');
const conceptA = (await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 'A concept', 'angle A', 'v', 'draft') returning id`, [A]))[0].id;
const conceptB = (await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 'B concept', 'angle B', 'v', 'draft') returning id`, [B]))[0].id;
const scriptA = (await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', 'ha') returning id`, [conceptA]))[0].id;
const scriptB = (await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', 'hb') returning id`, [conceptB]))[0].id;
{
  const take = async (script, idx, key, speaker, voice, at) => {
    const [a] = await q(`insert into assets (kind, storage_key, meta) values ('audio', $1, $2) returning id`, [key, JSON.stringify({ line: idx, speaker })]);
    await q(
      `insert into vo_takes (script_id, chunk_idx, driver, model, voice_id, language, text_in, asset_id, created_at) values ($1, $2, 'd', 'm', $3, 'en', 'line', $4, $5)`,
      [script, idx, voice, a.id, at],
    );
  };
  await take(scriptA, 0, 'vo/a/en/000.wav', 'pip', `${PROVIDER}:Chad`, '2026-10-01T00:00:00Z');
  await take(scriptA, 1, 'vo/a/en/001.wav', 'pip', `${PROVIDER}:Chad`, '2026-10-02T00:00:00Z');
  await take(scriptA, 2, 'vo/a/en/002.wav', 'marlo', `${PROVIDER}:Clint`, '2026-10-03T00:00:00Z');
  await take(scriptB, 0, 'vo/b/en/000.wav', 'pip', `${PROVIDER}:Rachel`, '2026-10-05T00:00:00Z'); // newer, other channel

  const screen = await voicesScreen(db, A, cb);
  const pip = screen.rows.find((r) => r.slug === 'pip');
  const marlo = screen.rows.find((r) => r.slug === 'marlo');
  check(pip.take?.storageKey === 'vo/a/en/001.wav', "pip's take is A's newest, not B's newer one", pip.take?.storageKey);
  check(pip.take?.matchesRoute === true, '  · and it was spoken in the voice the stage uses now');
  check(marlo.take?.storageKey === 'vo/a/en/002.wav', 'marlo gets his own take', marlo.take?.storageKey);
  check(screen.rows.find((r) => r.slug === 'nib').take === null, 'a character with no take has none');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n7. Prompts: no watched sample, no activation; the rate is the card’s\n');
{
  const [rec] = await q(`select id, is_active, sample_output_url from prompts where name = 'bureau-character-beat-gen4-turbo' and version = 1`);
  check(rec && rec.is_active === false && rec.sample_output_url === null, 'precondition: 0044 seeds it retired with no sample', JSON.stringify(rec));
  const refused = await reinstateRecipe(db, rec.id);
  check(
    !refused.ok && refused.problem === 'Not reinstated: no sample output recorded — activate a recipe only after watching a clip it produced, and give that clip’s URL.',
    'reinstating with no sample is refused by name',
    refused.ok ? 'accepted' : refused.problem,
  );
  check((await q(`select is_active from prompts where id = $1`, [rec.id]))[0].is_active === false, '  · and it is still retired');
  const notUrl = await reinstateRecipe(db, rec.id, 'watched it, trust me');
  check(!notUrl.ok && notUrl.problem === 'Not reinstated: "watched it, trust me" is not a URL.', 'a sample that is not a URL is refused');
  const accepted = await reinstateRecipe(db, rec.id, 'https://example.test/clip.mp4');
  const after = (await q(`select is_active, sample_output_url from prompts where id = $1`, [rec.id]))[0];
  check(accepted.ok && after.is_active === true && after.sample_output_url === 'https://example.test/clip.mp4', 'with a watched clip it is active and the URL is recorded', JSON.stringify(after));

  const [r] = await q(`select driver, model, params from prompts where id = $1`, [rec.id]);
  const rate = await recipeRate(db, { driver: r.driver, model: r.model, params: r.params });
  // 0044 inserts 0.05 USD per second for this model; the literal is the migration's.
  check(rate.priced && rate.label === 'USD 0.05 per second (rate card)', 'its rate is the 0044 card figure', rate.priced ? rate.label : rate.reason);
  const none = await recipeRate(db, { driver: r.driver, model: 'no-such-model', params: {} });
  check(!none.priced && none.reason.startsWith(`${r.driver}/no-such-model per second: no rate card row effective on or before`), 'an unknown model is unpriced, with the lookup’s reason', none.priced ? none.label : none.reason);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n8. Music: confirm refuses outside the pool; a default needs an upload\n');
{
  const beds = async () => Number((await q(`select count(*)::int as n from music_beds`))[0].n);
  const notPool = await confirmBedUpload(db, { channelId: A, cb, input: { bedId: 'bed_not_in_any_pool', contentType: 'audio/mpeg', bytes: 1000 } });
  check(
    !notPool.ok && notPool.problem === 'Refused: "bed_not_in_any_pool" is not in any bureau-of-reality series\' music_bed_pool. Add it to channels/bureau-of-reality/series/*.json first.',
    'a bed outside every pool is refused by name',
    notPool.ok ? 'accepted' : notPool.problem,
  );
  const video = await confirmBedUpload(db, { channelId: A, cb, input: { bedId: 'bed_typewriter_shuffle', contentType: 'video/mp4', bytes: 1000 } });
  check(!video.ok && video.problem.startsWith('Refused: audio only:'), 'a non-audio type is refused', video.ok ? 'accepted' : video.problem);
  const huge = await confirmBedUpload(db, { channelId: A, cb, input: { bedId: 'bed_typewriter_shuffle', contentType: 'audio/mpeg', bytes: MUSIC_MAX_BYTES + 1 } });
  check(!huge.ok && huge.problem === 'Refused: larger than 25 MB.', 'an oversize file is refused', huge.ok ? 'accepted' : huge.problem);
  check((await beds()) === 0, '  · none of the three wrote a row');

  const noUpload = await setSeriesDefault(db, { channelId: A, cb, series: 'incident', bedId: 'bed_fluorescent_hum' });
  check(
    !noUpload.ok && noUpload.problem === 'Not set: "bed_fluorescent_hum" has no audio uploaded on this channel. Upload it first.',
    'a default for a bed with no upload is refused by name',
    noUpload.ok ? 'accepted' : noUpload.problem,
  );

  const good = await confirmBedUpload(db, { channelId: A, cb, input: { bedId: 'bed_typewriter_shuffle', contentType: 'audio/mpeg', bytes: 1234 } });
  check(good.ok && good.verified === false && good.message.startsWith('Recorded bed_typewriter_shuffle — unverified:'), 'a pool bed is recorded, and says unverified', good.ok ? good.message : good.problem);
  const [row] = await q(`select storage_key, content_type, bytes from music_beds where channel_id = $1 and bed_id = 'bed_typewriter_shuffle'`, [A]);
  check(row?.storage_key === `music/${A}/bed_typewriter_shuffle.mp3` && row.content_type === 'audio/mpeg' && Number(row.bytes) === 1234, '  · under the server-built key', JSON.stringify(row));

  const wrongSeries = await setSeriesDefault(db, { channelId: A, cb, series: 'nonsense', bedId: 'bed_typewriter_shuffle' });
  check(!wrongSeries.ok && wrongSeries.problem === 'Not set: channel bureau-of-reality runs no series "nonsense".', 'a series the channel does not run is refused');
  const set = await setSeriesDefault(db, { channelId: A, cb, series: 'incident', bedId: 'bed_typewriter_shuffle' });
  check(set.ok, 'an uploaded pool bed becomes the default', set.ok ? set.message : set.problem);
  const screen = await musicScreen(db, A, cb);
  check(screen.series.find((s) => s.id === 'incident')?.defaultBed === 'bed_typewriter_shuffle', 'the screen shows it as incident’s default');
  check(screen.beds.find((b) => b.bedId === 'bed_fluorescent_hum')?.uploaded === null, 'a bed with no upload is null, not an empty row');
  const screenB = await musicScreen(db, B, cb);
  check(screenB.beds.every((b) => b.uploaded === null), "A's upload does not appear on B");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n9. Concepts: per channel, with the ledger summed exactly\n');
{
  // The figures, as literals. The expected sums are computed here from these, not read back.
  const SETTLED = [10.5];
  const ESTIMATED = [12.25, 3.5];
  const ledger = async (cols, vals) => q(`insert into cost_ledger (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
  await ledger(['concept_id', 'driver', 'stage', 'entry_kind', 'unit', 'quantity', 'cost_usd', 'cost_inr'], [conceptA, 'd', 'h-concept', 'estimate', 'call', 1, 0.1, ESTIMATED[0]]);
  await ledger(['concept_id', 'driver', 'stage', 'entry_kind', 'unit', 'quantity', 'cost_usd', 'cost_inr', 'cost_source'], [conceptA, 'd', 'h-concept', 'reconcile', 'call', 1, 0.1, SETTLED[0], 'measured']);
  await ledger(['script_id', 'driver', 'stage', 'entry_kind', 'unit', 'quantity', 'cost_usd', 'cost_inr'], [scriptA, 'd', 'h-script', 'estimate', 'token', 1, 0.1, ESTIMATED[1]]);
  await ledger(['concept_id', 'driver', 'stage', 'entry_kind', 'unit', 'quantity', 'cost_usd', 'cost_inr'], [conceptA, 'd', 'h-unpriced', 'estimate', 'call', 1, 0.1, null]);
  await ledger(['concept_id', 'driver', 'stage', 'entry_kind', 'unit', 'quantity', 'cost_usd', 'cost_inr'], [conceptB, 'd', 'h-b', 'estimate', 'call', 1, 0.1, 99]);

  const listA = await listConcepts(db, A);
  const listB = await listConcepts(db, B);
  const a = listA.find((c) => c.id === conceptA);
  check(!!a && !listA.some((c) => c.id === conceptB), "A's list has A's concept and not B's", listA.map((c) => c.title).join(', '));
  check(listB.length === 1 && listB[0].id === conceptB, "B's list is exactly B's concept");
  const sum = (xs) => xs.reduce((n, x) => n + x, 0);
  check(a.cost.settledInr === sum(SETTLED), 'settled is exactly the reconcile row', `${a.cost.settledInr} vs ${sum(SETTLED)}`);
  check(a.cost.estimatedInr === sum(ESTIMATED), 'estimated is exactly the concept + script estimate rows', `${a.cost.estimatedInr} vs ${sum(ESTIMATED)}`);
  check(a.cost.unpricedRows === 1 && a.cost.rows === 4, 'the unpriced row is counted, not summed as 0', JSON.stringify(a.cost));
  check(a.script?.id === scriptA && a.shotCount === 0, 'the script is linked and its shot count is a counted 0', JSON.stringify({ s: a.script, n: a.shotCount }));
  const b = listB[0];
  check(b.cost.settledInr === null && b.cost.estimatedInr === 99, "B's settled is null (no row), never 0", JSON.stringify(b.cost));
  const fresh = (await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 'no spend', 'x', 'v', 'draft') returning id`, [B]))[0].id;
  const f = (await listConcepts(db, B)).find((c) => c.id === fresh);
  check(f.cost.settledInr === null && f.cost.estimatedInr === null && f.script === null && f.shotCount === null, 'a concept with no ledger rows and no script is null throughout', JSON.stringify(f));
  check((await conceptOnChannel(db, conceptB, A)) === false && (await conceptOnChannel(db, conceptA, A)) === true, "the detail page's channel test refuses B's concept on A");
  check((await conceptOnChannel(db, 'not-a-uuid', A)) === false, '  · and an id that is not a uuid');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n10. Without 0046, the screens still render and say why\n');
{
  await q(`drop table music_bed_defaults; drop table music_beds; drop table channel_voice_overrides`);
  const v = await voicesScreen(db, A, cb);
  const NEEDS = 'needs migration 0046 — paste docs/bureau/hosted-migrations-5-0046.sql';
  check(v.tableMissing === NEEDS, 'voices: the sentence names the migration', v.tableMissing);
  const pip = v.rows.find((r) => r.slug === 'pip');
  check(pip.route.ok && pip.route.voiceId === diskPreset('pip'), '  · and every route is the bible’s');
  const w = await setVoiceOverride(db, { channelId: A, cb, setBy: null, input: { slug: 'pip', provider: PROVIDER, voiceId: 'Maya' } });
  check(!w.ok && w.problem === `Not saved: ${NEEDS}.`, '  · and a write refuses naming it', w.ok ? 'accepted' : w.problem);
  const m = await musicScreen(db, A, cb);
  check(m.tableMissing === NEEDS && m.beds.length > 0 && m.beds.every((b) => b.uploaded === null), 'music: the pool still lists, nothing uploaded, and the sentence says why');
  const c = await confirmBedUpload(db, { channelId: A, cb, input: { bedId: 'bed_typewriter_shuffle', contentType: 'audio/mpeg', bytes: 1 } });
  check(!c.ok && c.problem === `Not recorded: ${NEEDS}.`, '  · and confirm refuses naming it', c.ok ? 'accepted' : c.problem);
}

await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}
console.log('\nThe Library writes what the stages read, refuses by name, and tells absent from zero.\nWhat is left: a browser render, and a real presigned PUT to the bucket.\n');
