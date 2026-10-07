#!/usr/bin/env node
import { readFileSync } from 'node:fs';
/**
 * verify:episode — the definition of done, end to end, through the Kiln MCP connector.
 *
 *   agent drafts a brief → approver lists pending briefs → approves with punchline "B" →
 *   the episode run (script, shots, VOICE with real forced alignment, generation through the
 *   queue, ingest, QC, a REAL Remotion render of all three layers) → the cut is approved over
 *   MCP → publish_bundles returns a bundle whose MP4 downloads → mark_scheduled → cost is
 *   logged and under the per-Short cap.
 *
 * What is real: Postgres with every migration, the MCP server over HTTP, every step function
 * in src/lib/bureau, the dispatcher and claim_gen_jobs, runIngest + ffmpeg normalisation,
 * espeak-ng + the DTW aligner, @remotion/renderer with chrome-headless-shell, and an S3
 * endpoint (s3rver) behind the production storage driver.
 *
 * What is faked, and why that is the honest boundary: the vendors. The TTS "vendor" is
 * espeak-ng in a different voice (so alignment has real work to do), the video "vendor" is a
 * local HTTP server returning an ffmpeg test clip, and vision QC is a stub. The Trigger task
 * itself is not run — it is a thin sequence of these same functions plus wait tokens, which
 * this harness plays by completing them through the same effects interface.
 *
 * LOAD-BEARING: section 9 — a voice line that does not match its text must leave every shot
 * on an estimated duration, and then the CONSUMER (enqueueGeneration) must refuse, and the
 * blocker view must name why. Without it, the happy path above proves nothing about the
 * refusal Prompt H requires.
 *
 * Usage: node scripts/verify-episode.mjs <db-url>
 */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-episode.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { serveMcp } = require(`${B}/studio/serve.js`);
const { mintBureauToken } = require(`${B}/bureau/tokens.js`);
const { BUREAU_CHANNEL_ID } = require(`${B}/fixtures/seed-channel.js`);
const P = require(`${B}/bureau/episode-steps.js`);
const LF = require(`${B}/bureau/longform.js`);
const LF_CB = require(`${B}/bureau/bible.js`).bibleForSlug('bureau-of-reality');
const { restartHaltedEpisode } = require(`${B}/bureau/control.js`);
const { runDubJob } = require(`${B}/bureau/dubs.js`);
const { verifiedCredential } = require(`${B}/integrations/verify.js`);
const { dispatchProvider, advanceSubmitted, settleEpisodes } = require(`${B}/bureau/dispatch.js`);
const { signalQc } = require(`${B}/bureau/qc.js`);
const { episodeClips } = require(`${B}/bureau/overlay-only.js`);
const { renderBureau } = require(`${B}/bureau/layer-render.js`);
const { alignLine } = require(`${B}/voice/align.js`);
const { runIngest } = require(`${B}/ingest/run.js`);
const { createSupabaseStorageDriver } = require(`${B}/storage/supabase.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');
const { stubEmbedder } = await import('./lib/stub-embedder.mjs');

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};
const work = await mkdtemp(join(tmpdir(), 'kiln-verify-episode-'));

// ── S3 ──────────────────────────────────────────────────────────────────────
const S3Rver = (await import('s3rver')).default;
await mkdir(join(work, 's3'), { recursive: true });
const BUCKET = 'kiln-episode';
const s3 = new S3Rver({ port: 0, address: '127.0.0.1', silent: true, directory: join(work, 's3'), configureBuckets: [{ name: BUCKET }] });
const s3Addr = await new Promise((res) => s3.run((err, a) => (err ? Promise.reject(err) : res(a))));
const driver = createSupabaseStorageDriver({ accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', endpoint: `http://127.0.0.1:${s3Addr.port}`, bucket: BUCKET, region: 'us-east-1' });
const presign = async (key) => (await driver.presignGet({ key, expiresIn: 3600 })).url;
const putBytes = async (key, body) => {
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  const bytes = Buffer.concat(chunks);
  const signed = await driver.presignPut({ key, contentType: 'video/mp4' });
  const r = await fetch(signed.url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': 'video/mp4' } });
  if (!r.ok) throw new Error(`PUT ${key} ${r.status}`);
  return bytes.length;
};
const download = async (url, out) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} ${r.status}`);
  await writeFile(out, Buffer.from(await r.arrayBuffer()));
};

// ── The fake video vendor: one test clip over HTTP ───────────────────────────
const clip = join(work, 'vendor-clip.mp4');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=4', '-pix_fmt', 'yuv420p', clip]);
let dubFile = null;
const vendor = createServer((req, res) => {
  if (req.url === '/dub.m4a' && dubFile) {
    res.writeHead(200, { 'content-type': 'audio/mp4' });
    createReadStream(dubFile).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'video/mp4' });
  createReadStream(clip).pipe(res);
});
await new Promise((r) => vendor.listen(0, '127.0.0.1', r));
const vendorUrl = `http://127.0.0.1:${vendor.address().port}/clip.mp4`;

// ── DB + MCP ─────────────────────────────────────────────────────────────────
const scratch = await scratchDatabase(dbUrl, 'episode');
const client = scratch.client;
const db = supabaseShim(client);
const effects = {
  started: [],
  woken: [],
  async startEpisode(id) { this.started.push(id); return `run_${id.slice(0, 8)}`; },
  async completeWaitToken(token, output) { this.woken.push({ token, output }); },
  async notify() {},
  presign: async (key) => presign(key),
  // Embeddings are an input here (variation_check must have run before a brief can be
  // approved — 0044); the similarity itself is computed by the database.
  embedderFor: async () => stubEmbedder,
};
const mcp = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const r = await serveMcp({ authorization: req.headers.authorization ?? null, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }, { db, secret: undefined, bureau: effects });
    res.writeHead(r.status, { 'content-type': 'application/json' });
    res.end(r.body === null ? '' : JSON.stringify(r.body));
  });
});
await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${mcp.address().port}/api/mcp`;
const call = async (name, args, token) => {
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
  const body = await res.json();
  return { result: body.result?.structuredContent, isError: body.result?.isError };
};

// The TTS "vendor": espeak in a different voice from the aligner's reference.
const routeFor = () => ({ ok: true, provider: 'runway', voiceId: 'Maya', integration: 'runway', model: 'eleven_v3' });
const synthFrom = (speak) => async ({ text, outPath }) => {
  await run('espeak-ng', ['-v', 'en-gb+m3', '-s', '150', '-p', '35', '-w', outPath, speak(text)]);
  return { ok: true, path: outPath, requestId: `tts_${randomUUID().slice(0, 8)}`, words: null, estimatedCredits: Math.ceil(text.length / 50) };
};

// The bible's own still style, read from the folder bible the harness imports — not a copy of
// its wording, which changed once already (07-Oct: chalk → cartoon).
const BUREAU_STILL_STYLE = JSON.parse(readFileSync(new URL('../channels/bureau-of-reality/characters.json', import.meta.url), 'utf8')).world.still_style;
console.log('\nEpisode end to end — brief to publish bundle through the Kiln connector\n');
try {
  const { rows: prof } = await client.query(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'sahil@invalid.test', 88) returning id`);
  const approver = await mintBureauToken(db, { name: 'Sahil', scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId: prof[0].id });
  const agent = await mintBureauToken(db, { name: 'Routine C', scope: 'agent', channelId: BUREAU_CHANNEL_ID, profileId: null });

  // The world a generated shot needs: a locked reference for Pip, an active recipe that has
  // carried a character reference, and a verified per-second rate. Inputs, not assertions.
  // Since 0015 the character beat routes to the Runway API with failover off, so the world is
  // a gen4_turbo recipe and the generation key. The per-second rate is NOT seeded here: it is
  // migration 0044's row (USD 0.05/s), read back so the expected figure below comes from the
  // table the estimator reads rather than from a constant this harness invented.
  await client.query(`insert into prompts (name, driver, model, template, params, tags, discovered_in, is_active, accepts_character_ref) values ('pip-beat', 'runway', 'gen4_turbo', '{{description}}', '{"max_duration_s": 10}', '{subject_medium}', 'manual', true, true)`);
  const { rows: rateRow } = await client.query(`select unit_cost from rate_card where driver = 'runway' and model = 'gen4_turbo' and unit = 'second' and endpoint is null and is_verified`);
  const GEN_RATE_USD = Number(rateRow[0]?.unit_cost);
  check(GEN_RATE_USD === 0.05, 'migration 0044 seeds gen4_turbo at USD 0.05 per second (5 credits × $0.01)', String(rateRow[0]?.unit_cost));
  await client.query(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('runway', 'video', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);

  // ═══ 1. Draft (agent) ═══
  console.log('1. Draft and approve over MCP\n');
  const SCRIPT = 'Pip: I may have misplaced the Moon.\nMarlo: The Moon pulls the oceans into two bulges.\nPip: So no Moon means no tides?\nMarlo: Smaller ones. The Sun still pulls.\nPip: Tides are now on strike.';
  const brief = {
    slot_id: 'S001', series: 'incident', lead_character: 'pip', supporting_characters: ['marlo'], desk: 'gravity',
    premise: 'Pip misplaces the Moon and the tides go on strike by Friday.', premise_type: 'what_if_removed',
    structure_variant: 'ladder_hourly', ending_type: 'callback_gag', music_bed: 'bed_typewriter_shuffle', hook_archetype: 'story_open',
    punchlines: ['The Moon is in the lost and found.', 'Tides are now on strike.', 'Marlo files it under Unavailable.'],
    beat_sheet: [{ beat_id: 'cold_open', summary: 'Empty sky.' }],
    script_text: SCRIPT,
    shot_list: [
      { beat_id: 'cold_open', route: 'overlay', description: 'Empty orbit ring', duration_s: 3, overlay: { kind: 'orbit', camera: 'slow dolly-in' } },
      { beat_id: 'stakes', route: 'character_beat', description: 'Pip drops his clipboard', duration_s: 2, characters: ['pip'] },
      { beat_id: 'mechanism_1', route: 'overlay', description: 'Two tidal bulges', duration_s: 4, overlay: { kind: 'cross_section', camera: 'static' } },
      { beat_id: 'button', route: 'overlay', description: 'Strike banner', duration_s: 3, overlay: { kind: 'graph', camera: 'slow pan' } },
    ],
    fact: { claim: "The Moon's gravity is the main cause of Earth's ocean tides.", source_url: 'https://oceanservice.noaa.gov/facts/moon-tides.html' },
    titles: [{ text: 'Pip lost the Moon', hook_archetype: 'story_open' }, { text: 'What if the Moon vanished?', hook_archetype: 'question' }, { text: 'Tides drop by two thirds', hook_archetype: 'number_claim' }],
    pinned_comment: 'Which desk should Pip break next?',
  };
  const created = await call('briefs_create_batch', { briefs: [brief] }, agent.plaintext);
  check(created.result?.created === 1, 'the agent drafts a brief', JSON.stringify(created.result?.results?.[0]));

  // ═══ 2. List and approve (approver) ═══
  const pending = await call('briefs_pending', {}, approver.plaintext);
  check(pending.result?.count === 1, 'briefs_pending lists it');
  const approve = await call('brief_approve', { id: pending.result.briefs[0].id, punchline: 'B' }, approver.plaintext);
  const ep = approve.result?.episode_id;
  check(!!ep && effects.started[0] === ep, 'brief_approve with "B" starts the episode run', approve.result?.punchline);

  // Pip's reference frame, now that syncCast will have run inside prepareScript.
  const script1 = await P.prepareScript(db, ep, { apiKey: null, usdInrRate: 88 });
  // A frame locked into our own bucket, the shape `pnpm frame:lock` writes.
  await client.query(`update characters set external_ref_id = 'storage:characters/pip/ref-1.png', driver = 'runway', reference_urls = '{}' where channel_id = $1 and slug = 'pip'`, [BUREAU_CHANNEL_ID]);
  check(!!script1.scriptId, 'the script is written from the approved brief', script1.reason ?? '');
  const { rows: sRow } = await client.query('select vo_text, beats from scripts where id = $1', [script1.scriptId]);
  check(sRow[0].vo_text.includes('Tides are now on strike.'), 'the approved punchline is in the spoken text');

  // ═══ 3. Shots, cap ═══
  console.log('\n2. Shots, voice, generation\n');
  // This first episode exercises the VIDEO queue end to end, so scene stills (0021) are switched
  // off for it with the per-channel kill switch — which is itself the thing asserted here: off
  // means the plan is exactly what it was before stills existed, and says why.
  await client.query('update channel_policy set stills_enabled = false where channel_id = $1', [BUREAU_CHANNEL_ID]);
  const plan = await P.planShots(db, ep, { usdInrRate: 88, actedBeatAvailable: false });
  const [{ qc: planQc }] = (await client.query('select qc from episodes where id = $1', [ep])).rows;
  check(/switched off/.test(planQc.plan.stills ?? '') && !plan.swaps.some((x) => x.to === 'still'), 'stills switched off: the plan says so and nothing becomes a still', planQc.plan.stills);
  await client.query('update channel_policy set stills_enabled = true where channel_id = $1', [BUREAU_CHANNEL_ID]);
  const { rows: shots } = await client.query('select idx, render_route, vo_char_start, vo_char_end from shots where script_id = $1 order by idx', [script1.scriptId]);
  check(shots.length === 4 && shots[1].render_route === 'character_beat', 'four shots, the character beat kept (reference, recipe, rate all present)', JSON.stringify(plan.swaps));
  check(shots[0].vo_char_start === 0 && shots[3].vo_char_end === sRow[0].vo_text.length, 'the shots cover the spoken text end to end');

  // ═══ 4. Voice ═══
  // The voice stage asks the shared predicate (integrations/state.ts), not "does a key exist".
  // A key IS in the environment here, written explicitly (never ??=) and removed after, so the
  // refusal below can only come from verification.
  process.env.RUNWAY_API_KEY = 'test-key';
  const realKeyFor = (provider) => verifiedCredential(db, provider, 'RUNWAY_API_KEY');
  await client.query(`update integrations set last_verified_at = null, last_checked_at = null where slug = 'runway'`);
  const synthCalls = [];
  const refusedVoice = await P.voiceStep(db, ep, { usdInrRate: 88, apiKeyFor: realKeyFor, synth: (i) => { synthCalls.push(i); throw new Error('must not synthesise'); }, align: (i) => alignLine(i), putBytes, presign, routeFor });
  check(!refusedVoice.ok && refusedVoice.code === 'integration_unverified' && /runway integration has never verified/.test(refusedVoice.detail),
    'voice refuses an unverified integration by name, with its key present in the environment', refusedVoice.ok ? 'it ran' : `${refusedVoice.code}: ${refusedVoice.detail.slice(0, 90)}`);
  check(synthCalls.length === 0 && Number((await client.query(`select count(*) n from cost_ledger where script_id = $1 and stage = '06-voice'`, [script1.scriptId])).rows[0].n) === 0,
    'nothing synthesised and no ledger row');
  // Tested and failed, never verified: refused, with the test's error in the reason.
  await client.query(`update integrations set last_verified_at = null, last_checked_at = now(), last_error = 'HTTP 401' where slug = 'runway'`);
  const failedVoice = await P.voiceStep(db, ep, { usdInrRate: 88, apiKeyFor: realKeyFor, synth: () => { throw new Error('must not synthesise'); }, align: (i) => alignLine(i), putBytes, presign, routeFor });
  check(!failedVoice.ok && /never verified/.test(failedVoice.detail) && /HTTP 401/.test(failedVoice.detail), 'and one whose test failed, naming the failure', failedVoice.ok ? 'it ran' : failedVoice.detail.slice(0, 90));
  await client.query(`update integrations set last_verified_at = now(), last_checked_at = now() - interval '1 second', last_error = null where slug = 'runway'`);
  // The accept path, through the same real function: verified, so the key reaches the synth.
  const voice = await P.voiceStep(db, ep, { usdInrRate: 88, apiKeyFor: realKeyFor, synth: (i) => { synthCalls.push(i.apiKey); return synthFrom((t) => t)(i); }, align: (i) => alignLine(i), putBytes, presign, routeFor });
  check(synthCalls.length > 0 && synthCalls.every((k) => k === 'test-key'), 'verified → the environment key reaches the synthesiser', `${synthCalls.length} lines`);
  check(voice.ok, 'every line spoken and aligned', voice.ok ? `${voice.lines} lines, ${voice.totalS}s` : `${voice.code}: ${voice.detail}`);
  const lines = sRow[0].beats.lines;
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  const { rows: voLedger } = await client.query(`select quantity, cost_inr, entry_kind, cost_source from cost_ledger where script_id = $1 and stage = '06-voice'`, [script1.scriptId]);
  const expectVoiceInr = chars * 0.0002 * 88;
  check(voLedger.length === 1 && Number(voLedger[0].quantity) === chars && Math.abs(Number(voLedger[0].cost_inr) - expectVoiceInr) < 1e-9, 'one voice ledger row: characters × 1 credit/50 × $0.01 × ₹88', `${voLedger[0]?.cost_inr} vs ${expectVoiceInr}`);
  check(voLedger[0]?.entry_kind === 'estimate' && voLedger[0]?.cost_source === 'rate_card', 'an estimate on the rate card, never a reconcile nobody measured');
  const { rows: takes } = await client.query(`select chunk_idx, jsonb_array_length(word_timings) n, text_in from vo_takes where script_id = $1 order by chunk_idx`, [script1.scriptId]);
  check(takes.length === lines.length && takes.every((t) => t.n === t.text_in.trim().split(/\s+/).length), 'aligned word count === script word count, on every line');
  const { rows: timed } = await client.query(`select count(*) filter (where duration_source = 'derived_from_vo') d, sum(duration_s) s from shots where script_id = $1`, [script1.scriptId]);
  const { rows: track } = await client.query(`select a.storage_key from episodes e join assets a on a.id = (e.voice_detail->>'vo_asset_id')::uuid where e.id = $1`, [ep]);
  await download(await presign(track[0].storage_key), join(work, 'track.m4a'));
  const { stdout: trackDur } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(work, 'track.m4a')]);
  check(Number(timed[0].d) === 4 && Math.abs(Number(timed[0].s) - Number(trackDur)) < 0.1, 'every shot derived from the voice, and they tile the VO track (ffprobe of the stored file)', `${Number(timed[0].s).toFixed(2)} s vs ${Number(trackDur).toFixed(2)} s`);

  // ═══ 5. Generation through the queue ═══
  const q = await P.enqueueGeneration(db, ep, { usdInrRate: 88 });
  check(q.queued === 1 && q.refused.length === 0, 'one generation job queued for the character beat', JSON.stringify(q));
  const { rows: job } = await client.query('select provider, estimate_inr, duration_s, params from gen_jobs where episode_id = $1', [ep]);
  // gen4_turbo bills whole seconds from 2 to 10 (SDK), so the billed length is the shot's
  // length rounded up, never under 2 — written out here, not computed by the code under test.
  const billed = Math.max(2, Math.ceil(Number(job[0].duration_s)));
  check(job[0].provider === 'runway' && job[0].params.duration_s === billed, 'routed to the generation vendor, submitted at the billed clip length', `${job[0].provider}, ${job[0].params.duration_s}s for a ${Number(job[0].duration_s).toFixed(2)}s shot`);
  check(Math.abs(Number(job[0].estimate_inr) - Math.round(billed * GEN_RATE_USD * 88 * 100) / 100) < 1e-9, 'its estimate is ONE call: billed seconds × the verified per-second rate × ₹88', String(job[0].estimate_inr));
  check(job[0].params.reference_frame === 'storage:characters/pip/ref-1.png' && job[0].params.image_url === undefined, 'the job stores the frame as the bible wrote it, never a resolved URL');
  await client.query(`update episodes set gen_wait_token = 'waitpoint_gen' where id = $1`, [ep]);
  const submitted = [];
  const deps = {
    db, worker: 'verify', usdInrRate: 88,
    credentialsFor: async () => ({ ok: true, values: { RUNWAY_API_KEY: 'x' } }),
    presign: async (key) => (key === 'characters/pip/ref-1.png' ? vendorUrl.replace('clip.mp4', 'pip.png') : Promise.reject(new Error(`unexpected key ${key}`))),
    submit: async (i) => { submitted.push(i); return { ok: true, requestId: 'req_1', pollRef: {} }; },
    // The vendor's terminal task reports its final charge; 15 credits is a stand-in figure.
    poll: async () => ({ state: 'succeeded', outputUrl: vendorUrl, downloadHeaders: {}, charged: { quantity: 15, unit: 'credit', usd: 0.15 } }),
    ingest: ({ generationId, assetUrl }) => runIngest({ generationId, assetUrl }, { db, putBytes }),
  };
  const d1 = await dispatchProvider('runway', 5, deps);
  check(d1.submitted === 1 && submitted[0].params.image_url?.endsWith('pip.png') && submitted[0].params.reference_frame === undefined, 'the dispatcher submits once, with Pip’s frame resolved from storage for this call only', JSON.stringify(d1));
  check((await client.query('select params from gen_jobs where episode_id = $1', [ep])).rows[0].params.image_url === undefined, 'and the resolved URL was not written back to the job');
  const { rows: genLedger } = await client.query(`select cl.entry_kind, cl.cost_inr from cost_ledger cl join generations g on g.id = cl.generation_id join gen_jobs j on j.generation_id = g.id where j.episode_id = $1`, [ep]);
  check(genLedger.length === 1 && genLedger[0].entry_kind === 'estimate', 'the generation cost row was written at submit');
  const d2 = await dispatchProvider('runway', 5, deps);
  check(d2.claimed === 0, 'a second dispatch claims nothing — no double submit');
  const adv = await advanceSubmitted('runway', deps);
  const { rows: recon } = await client.query(`select cl.quantity, cl.unit, cl.cost_source, cl.cost_inr from cost_ledger cl join gen_jobs j on j.generation_id = cl.generation_id where j.episode_id = $1 and cl.entry_kind = 'reconcile'`, [ep]);
  check(recon.length === 1 && Number(recon[0].quantity) === 15 && recon[0].unit === 'credit' && recon[0].cost_source === 'measured' && Math.abs(Number(recon[0].cost_inr) - 0.15 * 88) < 1e-9,
    'the vendor’s reported charge lands as a measured reconcile', JSON.stringify(recon[0]));
  const { rows: jobAfter } = await client.query(`select j.status, s.status shot_status from gen_jobs j join shots s on s.id = j.shot_id where j.episode_id = $1`, [ep]);
  check(adv.advanced === 1 && jobAfter[0].status === 'succeeded' && jobAfter[0].shot_status === 'ready', 'polled, ingested and normalised; the shot is ready', JSON.stringify(jobAfter[0]));
  const s1 = await settleEpisodes(db, async (t, o) => effects.woken.push({ token: t, output: o }));
  check(s1.woken === 1 && effects.woken.at(-1).token === 'waitpoint_gen', 'the parked episode run is woken, not polled');

  // ═══ 6. QC and assembly ═══
  console.log('\n3. QC, assembly (real Remotion render), cut, bundle\n');
  const qc = await P.qcClips(db, ep, { presign, download, signal: (p, d) => signalQc(p, d), vision: async () => ({ passed: true, reasons: [], scores: { stub: true } }) });
  check(qc.checked === 1 && qc.rerolled === 0, 'QC checks the clip (signal: real ffmpeg; vision: stub)', JSON.stringify(qc));
  // CI exports REMOTION_BROWSER_EXECUTABLE (see the install step); the dev container has a
  // Playwright headless shell. Either way it is the old-headless binary Remotion drives.
  const shell = process.env.REMOTION_BROWSER_EXECUTABLE || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
  const asm = await P.assembleEpisode(db, ep, {
    usdInrRate: 88, presign, putBytes, download,
    normaliseAudio: async (i, o) => run('ffmpeg', ['-v', 'error', '-y', '-i', i, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', o]),
    render: (i) => renderBureau({ ...i, width: 270, height: 480, fps: 30, browserExecutable: shell }),
  });
  check(asm.ok, 'three layers rendered', asm.ok ? `${asm.frames} frames` : `${asm.code}: ${asm.detail}`);
  if (asm.ok) {
    check(Math.abs(asm.frames / 30 - Number(trackDur)) <= 1 / 30 + 0.05, 'the cut is as long as the VO track', `${(asm.frames / 30).toFixed(2)} s vs ${Number(trackDur).toFixed(2)} s`);
    const { rows: layers } = await client.query(`select layer, a.storage_key from renders r join assets a on a.id = r.asset_id where r.script_id = $1 order by layer`, [script1.scriptId]);
    check(layers.map((l) => l.layer).join() === 'caption_layer,clean_master,composite', 'composite, clean master and caption layer all stored');
    const master = join(work, 'master.mp4');
    await download(await presign(layers.find((l) => l.layer === 'composite').storage_key), master);
    const { stdout: streams } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', master]);
    check(streams.includes('audio') && streams.includes('video'), 'the composite carries picture and the VO');
    // The run renders only the composite before the cut gate (the other two after approval).
    const asmDeps = { usdInrRate: 88, presign, putBytes, download, normaliseAudio: async (i, o) => run('ffmpeg', ['-v', 'error', '-y', '-i', i, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', o]), render: (i) => renderBureau({ ...i, width: 270, height: 480, fps: 30, browserExecutable: shell }) };
    const before = (await client.query('select master_render_id from episodes where id = $1', [ep])).rows[0].master_render_id;
    const one = await P.assembleEpisode(db, ep, asmDeps, { layers: ['composite'] });
    const { rows: afterOne } = await client.query('select final_render_id, master_render_id from episodes where id = $1', [ep]);
    check(one.ok && one.compositeRenderId && one.masterRenderId === null && one.captionRenderId === null && afterOne[0].final_render_id === one.compositeRenderId && afterOne[0].master_render_id === before,
      'a composite-only pass renders one layer, points the cut at it and leaves the master alone', JSON.stringify({ one, afterOne }));
  }

  // ═══ 7. Cut gate over MCP ═══
  await client.query(`update episodes set status = 'awaiting_cut', cut_wait_token = 'waitpoint_cut' where id = $1`, [ep]);
  const status = await call('episode_status', { id: ep }, approver.plaintext);
  check(status.result?.status === 'awaiting_cut' && status.result?.jobs?.length === 1, 'episode_status shows the cut waiting, with its jobs');
  const cut = await call('cut_approve', { id: ep }, approver.plaintext);
  check(cut.result?.decision === 'pass' && effects.woken.at(-1).token === 'waitpoint_cut', 'cut_approve passes and wakes the run');

  // ═══ 8. Bundle over MCP ═══
  const bundle = await P.bundleEpisode(db, ep);
  const bundles = await call('publish_bundles', {}, approver.plaintext);
  const b0 = bundles.result?.bundles?.[0];
  check(b0?.publication_id === bundle.publicationId && b0.bundle.made_for_kids === false && b0.bundle.contains_synthetic_media === false, 'publish_bundles returns the bundle: madeForKids=false, no realistic scene', b0?.title);
  const dl = b0?.download_urls?.video ? await fetch(b0.download_urls.video) : null;
  const bytes = dl?.ok ? (await dl.arrayBuffer()).byteLength : 0;
  check(bytes > 1000, 'the bundle’s MP4 downloads', `${bytes} bytes`);
  check(b0?.bundle?.slot_time !== null && /Source: https:\/\/oceanservice\.noaa\.gov/.test(b0?.description ?? ''), 'the bundle carries the slot time and the sourced fact');
  const sched = await call('mark_scheduled', { id: bundle.publicationId, at: b0.bundle.slot_time }, approver.plaintext);
  check(sched.result?.publication?.status === 'scheduled', 'mark_scheduled at the slot time');

  // ═══ 9. Cost, under the cap ═══
  const { rows: spend } = await client.query('select spent_inr, unpriced_rows from v_episode_spend where episode_id = $1', [ep]);
  // The measured reconcile replaces the generation estimate (v_ledger_effective).
  const expected = expectVoiceInr + 0.15 * 88;
  check(Math.abs(Number(spend[0].spent_inr) - expected) < 1e-6 && Number(spend[0].unpriced_rows) === 0, 'episode spend = voice + the measured generation charge, every row priced', `₹${Number(spend[0].spent_inr).toFixed(2)}`);
  check(Number(spend[0].spent_inr) <= 150, 'under the ₹150 per-Short cap');
  const ledger = await call('costs_ledger', { range: '1d' }, approver.plaintext);
  check(ledger.result?.rows >= 2 && ledger.result?.unpriced_rows === 0, 'costs_ledger reports it over MCP', `${ledger.result?.rows} rows`);


  // ═══ 9b. Dubs ═══
  console.log('\n5. A Hindi dub of the approved episode\n');
  const dq = await call('dub_queue', { action: 'add', episode_id: ep, languages: ['hi'] }, agent.plaintext);
  check(dq.result?.queued?.length === 1, 'an agent token queues a dub', JSON.stringify(dq.result?.queued));
  const [dubRow] = (await client.query(`select id from dub_jobs where episode_id = $1 and language = 'hi'`, [ep])).rows;
  dubFile = join(work, 'track.m4a');
  const dubSubmits = [];
  // Unverified: refused by name before anything moves; the job stays queued and says why.
  await client.query(`update integrations set last_verified_at = null where slug = 'runway'`);
  const refusedDub = await runDubJob(dubRow.id, {
    db, usdInrRate: 88, presign, putBytes, download,
    rateKey: { driver: 'runway', model: 'eleven_voice_dubbing', endpoint: '/v1/voice_dubbing', unit: 'credit' },
    apiKey: () => verifiedCredential(db, 'runway', 'RUNWAY_API_KEY'),
    submit: async (i) => { dubSubmits.push(i); return { ok: true, taskId: 'never', estimatedCredits: 1 }; },
    wait: async () => ({ state: 'failed', code: 'x', detail: 'x' }),
  });
  const [dqRow] = (await client.query('select status, error from dub_jobs where id = $1', [dubRow.id])).rows;
  check(!refusedDub.ok && refusedDub.code === 'integration_unverified' && dubSubmits.length === 0,
    'dubs refuse an unverified integration by name, before submitting', refusedDub.ok ? 'it ran' : refusedDub.code);
  check(dqRow.status === 'queued' && /^integration_unverified: /.test(dqRow.error ?? ''), 'the job stays queued, carrying the reason', `${dqRow.status} / ${dqRow.error?.slice(0, 60)}`);
  await client.query(`update integrations set last_verified_at = now() where slug = 'runway'`);
  const dub = await runDubJob(dubRow.id, {
    db, usdInrRate: 88, presign, putBytes, download,
    rateKey: { driver: 'runway', model: 'eleven_voice_dubbing', endpoint: '/v1/voice_dubbing', unit: 'credit' },
    apiKey: () => verifiedCredential(db, 'runway', 'RUNWAY_API_KEY'),
    submit: async (i) => { dubSubmits.push(i); return { ok: true, taskId: 'dub_1', estimatedCredits: 120 }; },
    wait: async () => ({ state: 'succeeded', outputUrl: vendorUrl.replace('clip.mp4', 'dub.m4a') }),
    translate: async (lines) => lines.map((l) => `[hi] ${l}`),
  });
  check(dub.ok && dubSubmits[0].speakers === 2 && dubSubmits[0].language === 'hi', 'the VO stem goes to the dubber with its speaker count', JSON.stringify(dubSubmits[0] ?? {}).slice(0, 120));
  const [dubCost] = (await client.query(`select quantity, cost_inr, unit from cost_ledger where stage = 'dub:hi' and script_id = $1`, [script1.scriptId])).rows;
  check(dubCost && Number(dubCost.quantity) === 120 && Math.abs(Number(dubCost.cost_inr) - 120 * 0.01 * 88) < 1e-9, 'its cost is the vendor’s credit estimate × $0.01 × ₹88, written at submit', JSON.stringify(dubCost));
  const [dj] = (await client.query('select status, audio_asset_id, srt_asset_id from dub_jobs where id = $1', [dubRow.id])).rows;
  check(dj.status === 'ready' && dj.audio_asset_id && dj.srt_asset_id, 'the dub is ready with an audio track and line-timed captions');
  check(dubSubmits[0]?.apiKey === 'test-key', 'verified → the dub is submitted with the environment key');
  const withDub = await call('publish_bundles', {}, approver.plaintext);
  const dubOut = withDub.result?.bundles?.find((x) => x.episode_id === ep)?.dubs?.[0];
  check(dubOut?.language === 'hi' && /rate unverified/.test(dubOut?.cost_label ?? '') && dubOut?.audio_url, 'the bundle carries the Hindi track, labelled "rate unverified"');

  // ═══ 9c. Long-form ═══
  console.log('\n6. A long-form episode around the aired Short\n');
  const coldOpen = 'Pip: Previously, on the Bureau.\nMarlo: You lost the Moon.';
  const complaint = 'Complaint Box: Why do tides keep changing?\nMarlo: Because the Moon keeps moving, and so do we.';
  const segments = [
    { type: 'scene', purpose: 'cold open', lines: coldOpen, shots: [{ route: 'overlay', description: 'Recap board', duration_s: 4, characters: [], realistic: false }] },
    { type: 'short', slot_id: 'S001' },
    { type: 'scene', purpose: 'mid-episode Complaint Box moment', lines: complaint, shots: [{ route: 'overlay', description: 'Complaint slip', duration_s: 5, characters: [], realistic: false }] },
  ];
  const masters = await LF.airedMasters(db, BUREAU_CHANNEL_ID);
  check(masters.S001?.durationS > 10, 'the aired Short’s clean master is found with a measured duration', String(masters.S001?.durationS));
  const lfProblems = LF.validateSegments(segments, { S001: masters.S001.durationS }, LF_CB);
  check(lfProblems.length === 1 && /8–12 minutes/.test(lfProblems[0]), 'the real validator only objects to the length of this short test fixture', lfProblems.join(' | '));
  const built = LF.longFormScript(segments);
  const [lfBrief] = (await client.query(`insert into briefs (channel_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, shot_list, fact, titles, pinned_comment, status, chosen_punchline, approved_at, created_by, segments)
     values ($1, 'long_form', 'pip', 'gravity', 'The week Pip lost the Moon, told properly.', 'x', 'y', 'z', 'w', 'story_open', '["a","b","c"]', '[]', $2, $3, $4, $5, 'p', 'approved', 'so do we', now(), 'agent', $6) returning id`,
    [BUREAU_CHANNEL_ID, built.script_text, JSON.stringify(built.shot_list), JSON.stringify(brief.fact), JSON.stringify(brief.titles), JSON.stringify(segments)])).rows;
  const [lfEp] = (await client.query(`insert into episodes (brief_id, channel_id, kind, status) values ($1, $2, 'long_form', 'queued') returning id`, [lfBrief.id, BUREAU_CHANNEL_ID])).rows;
  await P.prepareScript(db, lfEp.id, { apiKey: null, usdInrRate: 88 });
  const lfPlan = await LF.planLongForm(db, lfEp.id, { usdInrRate: 88 });
  const [lfScript] = (await client.query('select script_id from episodes where id = $1', [lfEp.id])).rows;
  const lfShots = (await client.query('select idx, source_render_id, render_route from shots where script_id = $1 order by idx', [lfScript.script_id])).rows;
  check(lfPlan.shots === 3 && lfShots[1].source_render_id !== null && lfShots[0].source_render_id === null, 'scene, replay of S001, scene — in running order');
  const lfVoice = await P.voiceStep(db, lfEp.id, { usdInrRate: 88, apiKeyFor: async () => ({ ok: true, value: 'k' }), synth: synthFrom((t) => t), align: (i) => alignLine(i), putBytes, presign, routeFor });
  check(lfVoice.ok, 'only the new scenes are voiced', lfVoice.ok ? `${lfVoice.lines} lines` : lfVoice.detail);
  const lf = await LF.assembleLongForm(db, lfEp.id, {
    usdInrRate: 88, presign, putBytes, download,
    normaliseAudio: async (i, o) => run('ffmpeg', ['-v', 'error', '-y', '-i', i, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', o]),
    render: (i) => renderBureau({ ...i, width: 480, height: 270, fps: 30, browserExecutable: shell }),
  });
  check(lf.ok, 'the long-form renders', lf.ok ? `${lf.frames} frames` : `${lf.code}: ${lf.detail}`);
  if (lf.ok) {
    const durs = (await client.query('select duration_s from shots where script_id = $1 order by idx', [lfScript.script_id])).rows.map((r) => Number(r.duration_s));
    check(Math.abs(lf.frames / 30 - durs.reduce((a, b) => a + b, 0)) < 0.05 && Math.abs(durs[1] - masters.S001.durationS) < 1e-6, 'its length is the scenes plus the replayed master, exactly', `${(lf.frames / 30).toFixed(2)} s`);
    const [lfr] = (await client.query('select format, layer from renders where id = $1', [lf.renderId])).rows;
    check(lfr.format === 'longform_16x9' && lfr.layer === 'longform', 'stored as a 16:9 long-form render');
  }

  // ═══ 10. A voice the aligner cannot confirm ═══
  // This section used to assert a refusal: an unconfirmed alignment halted the episode. On the
  // first real run (S001, 2026-10-06) that refusal fired on every line of a CORRECT vendor
  // voice — the aligner's confidence test only separates espeak from espeak — so it was not a
  // guard, it was the chain being inert. Shot durations cut at line boundaries and every line
  // is its own ffprobe-measured file, so they never rested on word timings. What is asserted
  // now is what is still true when the aligner cannot see: durations are the measured line
  // spans, nothing is invented inside a line, and the count of unconfirmed lines travels with
  // the episode to the cut review, where a person hears every word before anything publishes.
  console.log('\n7. A voice the aligner cannot confirm\n');
  const b2 = await call('briefs_create_batch', { briefs: [{ ...brief, slot_id: 'S008', premise: 'Pip loses the Sun this time and the plants file a grievance.', structure_variant: 'blame_meeting', desk: 'orbit', hook_archetype: 'question', music_bed: 'bed_deep_sonar', premise_type: 'wrong_setting', ending_type: 'reversal' }] }, agent.plaintext);
  const a2 = await call('brief_approve', { id: b2.result.results[0].brief_id, punchline: 'A' }, approver.plaintext);
  const ep2 = a2.result.episode_id;
  await P.prepareScript(db, ep2, { apiKey: null, usdInrRate: 88 });
  await client.query(`update characters set external_ref_id = 'storage:characters/pip/ref-1.png', driver = 'runway', reference_urls = '{}' where channel_id = $1 and slug = 'pip'`, [BUREAU_CHANNEL_ID]);
  await P.planShots(db, ep2, { usdInrRate: 88, actedBeatAvailable: false });
  const wrongVoice = await P.voiceStep(db, ep2, { usdInrRate: 88, apiKeyFor: async () => ({ ok: true, value: 'k' }), synth: synthFrom(() => 'Calendars drift because a year is not a whole number of days at all.'), align: (i) => alignLine(i), putBytes, presign, routeFor });
  const { rows: ep2row } = await client.query('select script_id, voice_detail from episodes where id = $1', [ep2]);
  const { rows: ep2takes } = await client.query(`select count(*) n, count(*) filter (where word_timings = '[]'::jsonb and asset_id is not null) blank, sum(duration_s) d from vo_takes where script_id = $1 and language = 'en'`, [ep2row[0].script_id]);
  const takeCount = Number(ep2takes[0].n);
  check(wrongVoice.ok && wrongVoice.unaligned === Number(ep2takes[0].blank) && takeCount > 0, 'the stage goes on, and counts every line it could not confirm', wrongVoice.ok ? `${wrongVoice.unaligned} of ${takeCount}` : wrongVoice.detail.slice(0, 120));
  // LOAD-BEARING: the subject is written by the voice stage (episodes.voice_detail), and the
  // other side is counted from vo_takes, which the stage writes per line and this harness never touches.
  check(Number(ep2row[0].voice_detail?.unaligned) === Number(ep2takes[0].blank), 'LOAD-BEARING: the episode carries the unconfirmed-line count to the cut review', JSON.stringify(ep2row[0].voice_detail));
  const { rows: ep2shots } = await client.query(`select count(*) n, count(*) filter (where duration_source = 'derived_from_vo') d, sum(duration_s) s from shots where script_id = $1`, [ep2row[0].script_id]);
  check(Number(ep2shots[0].d) === Number(ep2shots[0].n), 'every shot is timed from the measured line spans', `${ep2shots[0].d} of ${ep2shots[0].n}`);
  check(Math.abs(Number(ep2shots[0].s) - wrongVoice.totalS) < 1e-3, 'and the shots add up to the measured track exactly', `${ep2shots[0].s} vs ${wrongVoice.totalS}`);
  check(Number(ep2takes[0].blank) > 0, 'the paid-for audio is kept, with absent word timings — not zeros, not an even split');
  const { rows: blk } = await client.query('select blocker from v_pipeline_blockers where script_id = $1', [ep2row[0].script_id]);
  check(!/forced alignment/.test(blk[0]?.blocker ?? ''), 'the blocker view no longer names alignment as a reason to stop', String(blk[0]?.blocker));

  // ═══ 10a. A restart re-uses what voice already paid for ═══
  // S001's restart (2026-10-07): 14 takes on file, one line rewritten, run again. The harness
  // removes one take and the episode's voice_detail (inputs); what is asserted is what the
  // stage did — how many lines it synthesised and how many it re-used.
  console.log('\n7a. A restart re-uses the paid-for takes\n');
  await client.query(`update episodes set voice_detail = null where id = $1`, [ep2]);
  await client.query(`delete from vo_takes where script_id = $1 and chunk_idx = 0`, [ep2row[0].script_id]);
  let reSynth = 0;
  const reVoice = await P.voiceStep(db, ep2, { usdInrRate: 88, apiKeyFor: async () => ({ ok: true, value: 'k' }), synth: (i) => { reSynth++; return synthFrom(() => 'Calendars drift because a year is not a whole number of days at all.')(i); }, align: (i) => alignLine(i), putBytes, presign, routeFor });
  check(reVoice.ok && reSynth === 1 && reVoice.reused === takeCount - 1, 'only the missing line is spoken again; the rest are re-used', reVoice.ok ? `synth ${reSynth}, reused ${reVoice.reused}` : `${reVoice.code}: ${reVoice.detail}`);

  // ═══ 10a'. Re-cut notes: a faster pace and one new voice ═══
  // Seeded: the rejection (status is an input) and a route that gives ONE speaker a new voice.
  // Asserted: what applyRecutNotes stored, which lines voiceStep spoke again, what it priced
  // before speaking, and that the paced track is shorter than the spoken one — all read back.
  console.log("\n7a'. Re-cut with notes: pace and one voice\n");
  const { applyRecutNotes } = require(`${B}/bureau/recut.js`);
  const { rows: [beforeNotes] } = await client.query('select voice_detail, brief_id, script_id from episodes where id = $1', [ep2]);
  const spokenS = Number(beforeNotes.voice_detail?.total_s);
  await client.query(`update episodes set status = 'cut_rejected' where id = $1`, [ep2]);
  const notesR = await applyRecutNotes(db, { channelId: BUREAU_CHANNEL_ID, tokenId: null, profileId: null }, ep2, { pace: 'fast', voicesChanged: ['test'] });
  const { rows: [afterNotes] } = await client.query('select e.voice_detail, b.approved_edits from episodes e join briefs b on b.id = e.brief_id where e.id = $1', [ep2]);
  check(notesR.ok && afterNotes.approved_edits.voice_pace === 'fast' && afterNotes.voice_detail === null, 'the pace is stored with the approval and the voice track is cleared for the re-run', JSON.stringify({ edits: afterNotes.approved_edits, vd: afterNotes.voice_detail }));
  let badPace = null;
  const badR = await applyRecutNotes(db, { channelId: BUREAU_CHANNEL_ID, tokenId: null, profileId: null }, ep2, { pace: 'ludicrous' });
  badPace = badR.ok ? null : badR.reason;
  check(/not a pace/.test(badPace ?? ''), 'a pace that does not exist is refused by name', badPace);
  const { rows: [scr] } = await client.query('select beats from scripts where id = $1', [beforeNotes.script_id]);
  const speakersInOrder = scr.beats.lines.map((l) => l.speaker);
  const changedSpeaker = speakersInOrder[0];
  const changedLines = scr.beats.lines.filter((l) => l.speaker === changedSpeaker);
  const reroute = (slug) => (slug === changedSpeaker ? { ...routeFor(slug), voiceId: 'Marlene' } : routeFor(slug));
  const respoken = [];
  const notesVoice = await P.voiceStep(db, ep2, { usdInrRate: 88, apiKeyFor: async () => ({ ok: true, value: 'k' }), synth: (i) => { respoken.push(i.text); return synthFrom(() => i.text)(i); }, align: (i) => alignLine(i), putBytes, presign, routeFor: reroute });
  check(notesVoice.ok && respoken.length === changedLines.length && respoken.every((t, k) => t === changedLines[k].text) && notesVoice.reused === scr.beats.lines.length - changedLines.length,
    'LOAD-BEARING: only the re-voiced speaker\'s lines are spoken again; every other paid line is re-used', JSON.stringify({ respoken: respoken.length, expected: changedLines.length, reused: notesVoice.ok ? notesVoice.reused : notesVoice.detail }));
  // Two re-speaks on this script: 7a's one restored line, then this voice change. Each is its own row.
  const { rows: ledgerR } = await client.query(`select stage, quantity from cost_ledger where script_id = $1 and stage like '06-voice-r%' order by stage`, [beforeNotes.script_id]);
  const changedChars = changedLines.reduce((n, l) => n + l.text.length, 0);
  const restoredChars = scr.beats.lines.find((l) => l.idx === 0).text.length;
  check(ledgerR.length === 2 && ledgerR[0].stage === '06-voice-r1' && Number(ledgerR[0].quantity) === restoredChars && ledgerR[1].stage === '06-voice-r2' && Number(ledgerR[1].quantity) === changedChars,
    'every re-speak is priced before speaking, for exactly the characters it speaks, under a stage of its own (rule 5) — before this a re-speak was never priced', JSON.stringify(ledgerR));
  const { rows: [paced] } = await client.query('select voice_detail from episodes where id = $1', [ep2]);
  check(paced.voice_detail?.pace === 'fast' && Number(paced.voice_detail.total_s) < spokenS, 'the re-cut track is at the fast pace and shorter than before', `${paced.voice_detail?.total_s} s vs ${spokenS} s`);

  // ═══ 10b. Restarting a halted episode ═══
  // The halt is SEEDED (status is an input); what is asserted is what restartHaltedEpisode did
  // with it — the key it handed the runner and the run id it wrote back.
  console.log('\n7b. Restarting a halted episode\n');
  const keys = [];
  const runner = { async startEpisode(id, attempt) { keys.push(attempt); return `run_restart_${keys.length}`; }, async completeWaitToken() {} };
  const approverTok = { id: approver.id, name: 'Sahil', scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId: null };
  await client.query(`update episodes set status = 'halted', status_detail = 'voice_not_locked: test', updated_at = '2026-10-06T17:33:56Z' where id = $1`, [ep2]);
  const r1 = await restartHaltedEpisode(db, approverTok, runner, { episode_id: ep2 });
  const { rows: afterR1 } = await client.query('select run_id, status, status_detail from episodes where id = $1', [ep2]);
  check(r1.ok && afterR1[0].run_id === r1.run_id && r1.run_id === 'run_restart_1' && afterR1[0].status === 'queued', 'a halted episode restarts, goes back to queued and records the new run', JSON.stringify(afterR1[0]));
  check(keys[0] === `restart:${Date.parse('2026-10-06T17:33:56Z')}`, 'the key is derived from the halt it restarts, so two clicks on one halt dedupe', String(keys[0]));
  let refusedNotHalted = null;
  try { await restartHaltedEpisode(db, approverTok, runner, { episode_id: ep2 }); } catch (err) { refusedNotHalted = err.message; }
  check(/not halted, failed, stalled or sent back/.test(refusedNotHalted ?? '') && keys.length === 1, 'an episode that is not halted is refused, and nothing is started', refusedNotHalted);
  await client.query(`update episodes set status = 'halted', updated_at = '2026-10-07T02:00:00Z' where id = $1`, [ep2]);
  let refusedAgent = null;
  try { await restartHaltedEpisode(db, { ...approverTok, scope: 'agent' }, runner, { episode_id: ep2 }); } catch (err) { refusedAgent = err.message; }
  check(/approver scope/.test(refusedAgent ?? '') && keys.length === 1, 'an agent token cannot restart a run', refusedAgent);
  await client.query(`update episodes set status = 'assembling', updated_at = now() - interval '31 minutes' where id = $1`, [ep2]);
  const rStall = await restartHaltedEpisode(db, approverTok, runner, { episode_id: ep2 });
  check(rStall.ok && keys.length === 2, 'a run silent for 30 min while assembling is restartable (the worker died without a status)', JSON.stringify(keys));
  await client.query(`update episodes set status = 'generating', updated_at = now() - interval '2 hours' where id = $1`, [ep2]);
  let refusedGen = null;
  try { await restartHaltedEpisode(db, approverTok, runner, { episode_id: ep2 }); } catch (err) { refusedGen = err.message; }
  check(/not halted, failed, stalled or sent back/.test(refusedGen ?? '') && keys.length === 2, 'a long vendor wait while generating is not mistaken for a stall', refusedGen);
  await client.query(`update episodes set status = 'halted', updated_at = '2026-10-07T03:00:00Z' where id = $1`, [ep2]);
  const r2 = await restartHaltedEpisode(db, approverTok, runner, { episode_id: ep2 });
  check(r2.ok && keys[2] !== keys[0] && keys[2] !== keys[1], 'a later halt restarts under a new key', JSON.stringify(keys));

  // Re-cut a sent-back cut with stills (S003, 07-Oct). Seeded: the rejection and one overlay
  // shot are inputs. Asserted: what restartHaltedEpisode did to the shot rows and the plan —
  // read back from the database, never from what the harness wrote.
  const { rows: [ep2Script] } = await client.query('select script_id from episodes where id = $1', [ep2]);
  const { rows: ep2Shots } = await client.query('select id, idx, render_route from shots where script_id = $1 order by idx', [ep2Script.script_id]);
  check(ep2Shots.length > 0, 'the second episode has shots to re-cut', String(ep2Shots.length));
  const target = ep2Shots[0];
  await client.query(`update shots set render_route = 'overlay' where id = $1`, [target.id]);
  await client.query(`update episodes set status = 'cut_rejected', status_detail = 'rejected: not related to the topic', updated_at = now() where id = $1`, [ep2]);
  await client.query('update channel_policy set stills_enabled = false where channel_id = $1', [BUREAU_CHANNEL_ID]);
  let refusedOff = null;
  try { await restartHaltedEpisode(db, approverTok, runner, { episode_id: ep2 }); } catch (err) { refusedOff = err.message; }
  const { rows: [stillOverlay] } = await client.query('select render_route from shots where id = $1', [target.id]);
  check(/Not re-cut: .*switched off/.test(refusedOff ?? '') && keys.length === 3 && stillOverlay.render_route === 'overlay', 'with stills off, a re-cut is refused by name, nothing starts and no shot changes — it would rebuild the rejected cut', refusedOff);
  await client.query('update channel_policy set stills_enabled = true where channel_id = $1', [BUREAU_CHANNEL_ID]);
  const r3 = await restartHaltedEpisode(db, approverTok, runner, { episode_id: ep2 });
  const { rows: [recut] } = await client.query('select status, run_id, qc from episodes where id = $1', [ep2]);
  const { rows: [nowStill] } = await client.query('select render_route from shots where id = $1', [target.id]);
  check(r3.ok && keys.length === 4 && recut.status === 'queued' && recut.run_id === r3.run_id, 'a sent-back cut restarts as a re-cut: queued, with the new run recorded', JSON.stringify({ status: recut.status, keys: keys.length }));
  check(nowStill.render_route === 'still' && JSON.stringify(recut.qc?.plan?.recut?.to_still ?? []) === JSON.stringify([target.idx]), 'LOAD-BEARING: the overlay shot is now a still and the plan names exactly that shot — without it the run rebuilds the cut that was sent back', JSON.stringify(recut.qc?.plan?.recut));
  const { rows: blk1 } = await client.query('select blocker from v_pipeline_blockers where script_id = $1', [script1.scriptId]);
  check(blk1[0]?.blocker === null, 'and for the episode that went through, the view says nothing blocks it', String(blk1[0]?.blocker));

  // ═══ 11. Scene stills (0021) ═══
  // A fresh episode with stills available: every shot that is not a money shot becomes a still,
  // the cast never appears in a still prompt, every still is ledgered before its call, a still
  // that fails becomes its overlay with the swap recorded, and the render draws the image.
  console.log('\n8. Scene stills\n');
  const stillPng = join(work, 'still.png');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xC0392B:s=720x1280', '-frames:v', '1', stillPng]);
  const stillServer = createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); createReadStream(stillPng).pipe(res); });
  await new Promise((r) => stillServer.listen(0, '127.0.0.1', r));
  const stillUrl = `http://127.0.0.1:${stillServer.address().port}/still.png`;
  try {
    const b3 = await call('briefs_create_batch', { briefs: [{ ...brief, slot_id: 'S015', premise: 'Pip unplugs the Moon to save power and the tides file for overtime.', structure_variant: 'ladder_hourly', desk: 'orbit', hook_archetype: 'story_open', premise_type: 'wrong_setting', ending_type: 'reversal' }] }, agent.plaintext);
    const briefId3 = b3.result?.results?.[0]?.brief_id;
    const [briefRow3] = (await client.query('select estimate_inr, estimate_basis from briefs where id = $1', [briefId3])).rows;
    const stillInr = Math.round(0.05 * 88 * 100) / 100;
    const routes3 = (briefRow3?.estimate_basis?.shots ?? []).map((x) => x.route);
    check(routes3.join() === 'still,still,still,still' && briefRow3.estimate_basis.shots.every((x) => x.inr === stillInr),
      'the brief is priced on the routes its episode will take: four stills at ₹4.40 (0.05 USD × ₹88)', JSON.stringify(briefRow3?.estimate_basis?.shots?.map((x) => [x.route, x.inr])));
    const a3 = await call('brief_approve', { id: briefId3, punchline: 'B' }, approver.plaintext);
    const ep3 = a3.result.episode_id;
    await P.prepareScript(db, ep3, { apiKey: null, usdInrRate: 88 });
    // The format picked at approval routes the plan (formats.ts). Seeded: the approver's pick in
    // approved_edits. Asserted: the shot rows planShots wrote and the format it recorded.
    // Then the shots are removed and the pick cleared, so the rest of this section plans as before.
    const { rows: [{ brief_id: b3Pick }] } = await client.query('select brief_id from episodes where id = $1', [ep3]);
    await client.query(`update briefs set approved_edits = approved_edits || '{"visual_format":"diagram"}' where id = $1`, [b3Pick]);
    await P.planShots(db, ep3, { usdInrRate: 88, actedBeatAvailable: false });
    const { rows: [diaEp] } = await client.query('select script_id, qc, estimate_inr from episodes where id = $1', [ep3]);
    const { rows: diaShots } = await client.query('select render_route from shots where script_id = $1', [diaEp.script_id]);
    check(diaShots.length === 4 && diaShots.every((x) => x.render_route === 'overlay') && diaEp.qc.plan.format.format === 'diagram' && diaEp.qc.plan.format.source === 'episode',
      'LOAD-BEARING: a diagram pick at approval plans every shot as a chalk overlay, and the plan records that the episode chose it', JSON.stringify({ routes: diaShots.map((x) => x.render_route), format: diaEp.qc.plan.format }));
    await client.query('delete from shots where script_id = $1', [diaEp.script_id]);
    await client.query(`update briefs set approved_edits = approved_edits - 'visual_format' where id = $1`, [b3Pick]);
    const plan3 = await P.planShots(db, ep3, { usdInrRate: 88, actedBeatAvailable: false });
    const [ep3row] = (await client.query('select script_id, estimate_inr, qc from episodes where id = $1', [ep3])).rows;
    const shots3 = (await client.query('select id, idx, render_route, overlay_spec, description from shots where script_id = $1 order by idx', [ep3row.script_id])).rows;
    check(shots3.length === 4 && shots3.every((x) => x.render_route === 'still') && shots3.every((x) => x.overlay_spec?.camera),
      'every shot is a still, each carrying its overlay (the fallback, and the camera move)', shots3.map((x) => x.render_route).join());
    check(plan3.swaps.some((x) => x.idx === 1 && x.from === 'character_beat' && x.to === 'still' && /illustrated format/.test(x.reason)),
      'the character beat became a still, and the plan says why', JSON.stringify(plan3.swaps));
    const voice3 = await P.voiceStep(db, ep3, { usdInrRate: 88, apiKeyFor: async () => ({ ok: true, value: 'k' }), synth: synthFrom((t) => t), align: (i) => alignLine(i), putBytes, presign, routeFor });
    check(voice3.ok, 'voiced', voice3.ok ? '' : voice3.detail);

    // The model: shot 1's rewrite still names Pip (must be refused by code); the others are clean.
    const castWord = /Pip drops/;
    const llmCalls = [];
    const llmClient = { messages: { parse: async (body) => {
      const user = String(body.messages[0].content);
      llmCalls.push(user);
      const scene = castWord.test(user) ? 'Pip standing beside a dropped clipboard on an office floor' : 'an empty orbit ring around a small globe, a filing cabinet in the corner';
      return { usage: { input_tokens: 300, output_tokens: 40 }, stop_reason: 'end_turn', parsed_output: { scene } };
    } } };
    const submits = [];
    const ledgerAtSubmit = [];
    const stillsRun = await P.generateStills(db, ep3, {
      usdInrRate: 88,
      llmKey: 'test-llm-key',
      llmClient,
      apiKey: () => verifiedCredential(db, 'runway', 'RUNWAY_API_KEY'),
      submit: async (i) => {
        submits.push(i);
        // LOAD-BEARING for rule 5: the estimate row must already exist when the vendor is called.
        const n = Number((await client.query(`select count(*) n from cost_ledger cl join generations g on g.id = cl.generation_id where g.status = 'submitting' and cl.entry_kind = 'estimate' and cl.stage = '05-still'`)).rows[0].n);
        ledgerAtSubmit.push(n);
        return submits.length === 2 ? { ok: false, code: 'content_rejected', detail: 'stub: the vendor refused this one' } : { ok: true, taskId: `still_${submits.length}` };
      },
      wait: async () => ({ state: 'succeeded', outputUrl: stillUrl, charged: { quantity: 5, unit: 'credit', usd: 0.05 } }),
      fetchBytes: async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()),
      putBytes,
    });
    check(stillsRun.made === 2 && stillsRun.fellBack.length === 2, 'two stills made, two fell back', JSON.stringify(stillsRun));
    check(submits.length === 3 && submits.every((x) => x.apiKey === 'test-key'), 'three reached the vendor (the cast-name one never did), with the verified key', String(submits.length));
    check(!submits.some((x) => /\bPip\b/i.test(x.prompt)) && submits.every((x) => /no people, no characters, no faces, no figures, no text/.test(x.prompt) && x.prompt.includes(BUREAU_STILL_STYLE) && x.prompt.includes('#22D3EE')),
      'no submitted prompt names the cast; every one carries the bible style, the lead accent and the no-people clause', submits[0]?.prompt.slice(0, 160));
    check(ledgerAtSubmit.length === 3 && ledgerAtSubmit.every((n) => n === 1), 'LOAD-BEARING: each still’s estimate row existed before its call (rule 5)', JSON.stringify(ledgerAtSubmit));
    const est3 = (await client.query(`select cl.cost_inr, cl.quantity, cl.unit, cl.idempotency_key from cost_ledger cl join generations g on g.id = cl.generation_id join shots s on s.id = g.shot_id where s.script_id = $1 and cl.entry_kind = 'estimate' and cl.stage = '05-still' order by cl.idempotency_key`, [ep3row.script_id])).rows;
    check(est3.length === 3 && est3.every((r) => Math.abs(Number(r.cost_inr) - 0.05 * 88) < 1e-9 && Number(r.quantity) === 1 && r.unit === 'image_720p' && /^still:[0-9a-f-]+:0:estimate$/.test(r.idempotency_key)),
      'three estimate rows: one 720p image × USD 0.05 × ₹88 = ₹4.40 each, keyed still:<shot>:<attempt>', JSON.stringify(est3.map((r) => [r.cost_inr, r.unit])));
    const rec3 = (await client.query(`select count(*) n from cost_ledger cl join generations g on g.id = cl.generation_id join shots s on s.id = g.shot_id where s.script_id = $1 and cl.entry_kind = 'reconcile' and cl.cost_source = 'measured' and cl.stage = '05-still'`, [ep3row.script_id])).rows[0].n;
    check(Number(rec3) === 2, 'the vendor’s reported charge lands as a measured reconcile on each still that came back', String(rec3));
    const after3 = (await client.query('select idx, render_route from shots where script_id = $1 order by idx', [ep3row.script_id])).rows;
    check(after3[1].render_route === 'overlay' && after3[2].render_route === 'overlay' && after3[0].render_route === 'still' && after3[3].render_route === 'still',
      'the refused and the failed still are now overlays; the others stay stills', after3.map((x) => x.render_route).join());
    const [{ qc: qc3 }] = (await client.query('select qc from episodes where id = $1', [ep3])).rows;
    const stillSwaps = qc3.plan.swaps.filter((x) => x.from === 'still');
    check(stillSwaps.length === 2 && /names Pip/.test(stillSwaps.find((x) => x.idx === 1)?.reason ?? '') && /content_rejected/.test(stillSwaps.find((x) => x.idx === 2)?.reason ?? ''),
      'both swaps are recorded where Cuts reads them, each with its reason', JSON.stringify(stillSwaps));
    const clips3 = await episodeClips(db, { script_id: ep3row.script_id, qc: qc3 });
    check(clips3.stills === 2 && clips3.overlayOnly === false && clips3.swaps.some((x) => /still → overlay/.test(x)), 'Cuts reads two stills, not overlay-only, and shows the swaps', JSON.stringify(clips3));
    const again = await P.generateStills(db, ep3, { usdInrRate: 88, llmKey: 'k', llmClient, apiKey: async () => ({ ok: true, value: 'x' }), submit: async () => { throw new Error('must not resubmit'); }, wait: async () => { throw new Error('x'); }, fetchBytes: async () => Buffer.alloc(0), putBytes });
    check(again.made === 0 && again.reused === 2, 'a replay re-uses both stored stills and pays for nothing', JSON.stringify(again));

    // The render draws the image: the props carry the stored still's URL, and Remotion renders it.
    const stillKeys = (await client.query(`select a.storage_key from assets a join generations g on g.id = a.generation_id join shots s on s.id = g.shot_id where s.script_id = $1 and a.kind = 'image' order by s.idx`, [ep3row.script_id])).rows.map((r) => r.storage_key);
    let seenProps = null;
    const asm3 = await P.assembleEpisode(db, ep3, {
      usdInrRate: 88, presign, putBytes, download,
      normaliseAudio: async (i, o) => run('ffmpeg', ['-v', 'error', '-y', '-i', i, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', o]),
      render: (i) => { seenProps = i.props; return renderBureau({ ...i, width: 270, height: 480, fps: 30, browserExecutable: shell }); },
    }, { layers: ['composite'] });
    const drawn = (seenProps?.shots ?? []).map((x) => x.type);
    check(asm3.ok && drawn.join() === 'still,overlay,overlay,still', 'the 270×480 composite renders, drawing still, overlay, overlay, still', asm3.ok ? drawn.join() : `${asm3.code}: ${asm3.detail}`);
    const stillProps = (seenProps?.shots ?? []).filter((x) => x.type === 'still');
    check(stillKeys.length === 2 && stillProps.length === 2 && stillProps.every((x, i) => x.url.includes(stillKeys[i]) && x.accent === '#22D3EE' && typeof x.camera === 'string'),
      'each still in the composition props is the stored asset, with the lead accent and a camera move', JSON.stringify(stillKeys));
    if (asm3.ok) {
      // The rendered frame in the middle of shot 0 carries the still's red, not the navy paper.
      const [comp3] = (await client.query(`select a.storage_key from renders r join assets a on a.id = r.asset_id where r.id = $1`, [asm3.compositeRenderId])).rows;
      const out3 = join(work, 'stills.mp4');
      await download(await presign(comp3.storage_key), out3);
      const { stdout: rgb } = await run('ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', out3, '-frames:v', '1', '-vf', 'crop=20:20:125:230,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' });
      check(rgb[0] > 150 && rgb[2] < 110, 'a frame of the cut is the still’s colour (decoded from the rendered MP4, not the props)', `rgb ${[...rgb.subarray(0, 3)].join(',')}`);
    }
    // ═══ 11b. The episode estimate prices stills against the cap ═══
    check(Math.abs(Number(ep3row.estimate_inr) - (Number(ep3row.qc.plan.estimate.voice_inr) + 4 * stillInr)) < 0.011, 'the episode estimate is the voice plus four stills, under the cap', `₹${ep3row.estimate_inr}`);
  } finally {
    stillServer.close();
  }
} catch (err) {
  check(false, 'harness threw', err.stack);
} finally {
  delete process.env.RUNWAY_API_KEY;
  mcp.close();
  vendor.close();
  await new Promise((r) => s3.close(r));
  await scratch.release();
  await rm(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED\n` : '\nThe definition of done holds end to end.\n');
process.exit(failures ? 1 : 0);
