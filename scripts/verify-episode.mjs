#!/usr/bin/env node
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
const { BUREAU_CHANNEL_ID } = require(`${B}/bureau/bible.js`);
const P = require(`${B}/bureau/episode-steps.js`);
const LF = require(`${B}/bureau/longform.js`);
const { runDubJob } = require(`${B}/bureau/dubs.js`);
const { dispatchProvider, advanceSubmitted, settleEpisodes } = require(`${B}/bureau/dispatch.js`);
const { signalQc } = require(`${B}/bureau/qc.js`);
const { renderBureau } = require(`${B}/bureau/layer-render.js`);
const { alignLine } = require(`${B}/voice/align.js`);
const { runIngest } = require(`${B}/ingest/run.js`);
const { createSupabaseStorageDriver } = require(`${B}/storage/supabase.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

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

console.log('\nEpisode end to end — brief to publish bundle through the Kiln connector\n');
try {
  const { rows: prof } = await client.query(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'sahil@invalid.test', 88) returning id`);
  const approver = await mintBureauToken(db, { name: 'Sahil', scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId: prof[0].id });
  const agent = await mintBureauToken(db, { name: 'Routine C', scope: 'agent', channelId: BUREAU_CHANNEL_ID, profileId: null });

  // The world a generated shot needs: a locked reference for Pip, an active recipe that has
  // carried a character reference, and a verified per-second rate. Inputs, not assertions.
  const FAL_RATE_USD = 0.084;
  await client.query(`insert into prompts (name, driver, model, template, params, tags, discovered_in, is_active, accepts_character_ref) values ('pip-beat', 'fal', 'fal-ai/kling-video/v3/standard/image-to-video', '{{description}}', '{"max_duration_s": 10}', '{subject_medium}', 'manual', true, true)`);
  await client.query(`insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note, effective_from) values ('fal', 'fal-ai/kling-video/v3/standard/image-to-video', null, 'second', $1, 'USD', true, 'harness', '2026-01-01')`, [FAL_RATE_USD]);
  await client.query(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('fal', 'video', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);

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
  await client.query(`update characters set external_ref_id = 'ref_pip', driver = 'fal', reference_urls = $2 where channel_id = $1 and slug = 'pip'`, [BUREAU_CHANNEL_ID, [vendorUrl.replace('clip.mp4', 'pip.png')]]);
  check(!!script1.scriptId, 'the script is written from the approved brief', script1.reason ?? '');
  const { rows: sRow } = await client.query('select vo_text, beats from scripts where id = $1', [script1.scriptId]);
  check(sRow[0].vo_text.includes('Tides are now on strike.'), 'the approved punchline is in the spoken text');

  // ═══ 3. Shots, cap ═══
  console.log('\n2. Shots, voice, generation\n');
  const plan = await P.planShots(db, ep, { usdInrRate: 88, actedBeatAvailable: false });
  const { rows: shots } = await client.query('select idx, render_route, vo_char_start, vo_char_end from shots where script_id = $1 order by idx', [script1.scriptId]);
  check(shots.length === 4 && shots[1].render_route === 'character_beat', 'four shots, the character beat kept (reference, recipe, rate all present)', JSON.stringify(plan.swaps));
  check(shots[0].vo_char_start === 0 && shots[3].vo_char_end === sRow[0].vo_text.length, 'the shots cover the spoken text end to end');

  // ═══ 4. Voice ═══
  const voice = await P.voiceStep(db, ep, { usdInrRate: 88, apiKeyFor: async () => 'test-key', synth: synthFrom((t) => t), align: (i) => alignLine(i), putBytes, presign, routeFor });
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
  const { rows: job } = await client.query('select provider, estimate_inr, duration_s from gen_jobs where episode_id = $1', [ep]);
  check(Math.abs(Number(job[0].estimate_inr) - Number(job[0].duration_s) * FAL_RATE_USD * 88) < 1e-9, 'its estimate is duration × the verified per-second rate × ₹88');
  await client.query(`update episodes set gen_wait_token = 'waitpoint_gen' where id = $1`, [ep]);
  const submitted = [];
  const deps = {
    db, worker: 'verify', usdInrRate: 88,
    credentialsFor: async () => ({ FAL_KEY: 'x' }),
    submit: async (i) => { submitted.push(i); return { ok: true, requestId: 'req_1', pollRef: { status_url: 'x', response_url: 'y' } }; },
    poll: async () => ({ state: 'succeeded', outputUrl: vendorUrl, downloadHeaders: {} }),
    ingest: ({ generationId, assetUrl }) => runIngest({ generationId, assetUrl }, { db, putBytes }),
  };
  const d1 = await dispatchProvider('fal', 5, deps);
  check(d1.submitted === 1 && submitted[0].params.image_url?.endsWith('pip.png'), 'the dispatcher submits once, with Pip’s reference frame', JSON.stringify(d1));
  const { rows: genLedger } = await client.query(`select cl.entry_kind, cl.cost_inr from cost_ledger cl join generations g on g.id = cl.generation_id join gen_jobs j on j.generation_id = g.id where j.episode_id = $1`, [ep]);
  check(genLedger.length === 1 && genLedger[0].entry_kind === 'estimate', 'the generation cost row was written at submit');
  const d2 = await dispatchProvider('fal', 5, deps);
  check(d2.claimed === 0, 'a second dispatch claims nothing — no double submit');
  const adv = await advanceSubmitted('fal', deps);
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
  const expected = expectVoiceInr + Number(job[0].duration_s) * FAL_RATE_USD * 88;
  check(Math.abs(Number(spend[0].spent_inr) - expected) < 1e-6 && Number(spend[0].unpriced_rows) === 0, 'episode spend = voice + generation, every row priced', `₹${Number(spend[0].spent_inr).toFixed(2)}`);
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
  const dub = await runDubJob(dubRow.id, {
    db, usdInrRate: 88, presign, putBytes, download,
    rateKey: { driver: 'runway', model: 'eleven_voice_dubbing', endpoint: '/v1/voice_dubbing', unit: 'credit' },
    submit: async (i) => { dubSubmits.push(i); return { ok: true, taskId: 'dub_1', estimatedCredits: 120 }; },
    wait: async () => ({ state: 'succeeded', outputUrl: vendorUrl.replace('clip.mp4', 'dub.m4a') }),
    translate: async (lines) => lines.map((l) => `[hi] ${l}`),
  });
  check(dub.ok && dubSubmits[0].speakers === 2 && dubSubmits[0].language === 'hi', 'the VO stem goes to the dubber with its speaker count', JSON.stringify(dubSubmits[0] ?? {}).slice(0, 120));
  const [dubCost] = (await client.query(`select quantity, cost_inr, unit from cost_ledger where stage = 'dub:hi' and script_id = $1`, [script1.scriptId])).rows;
  check(dubCost && Number(dubCost.quantity) === 120 && Math.abs(Number(dubCost.cost_inr) - 120 * 0.01 * 88) < 1e-9, 'its cost is the vendor’s credit estimate × $0.01 × ₹88, written at submit', JSON.stringify(dubCost));
  const [dj] = (await client.query('select status, audio_asset_id, srt_asset_id from dub_jobs where id = $1', [dubRow.id])).rows;
  check(dj.status === 'ready' && dj.audio_asset_id && dj.srt_asset_id, 'the dub is ready with an audio track and line-timed captions');
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
  const lfProblems = LF.validateSegments(segments, { S001: masters.S001.durationS });
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
  const lfVoice = await P.voiceStep(db, lfEp.id, { usdInrRate: 88, apiKeyFor: async () => 'k', synth: synthFrom((t) => t), align: (i) => alignLine(i), putBytes, presign, routeFor });
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

  // ═══ 10. LOAD-BEARING: the refusal ═══
  console.log('\n7. A voice that does not match its script\n');
  const b2 = await call('briefs_create_batch', { briefs: [{ ...brief, slot_id: 'S008', premise: 'Pip loses the Sun this time and the plants file a grievance.', structure_variant: 'blame_meeting', desk: 'orbit', hook_archetype: 'question', music_bed: 'bed_deep_sonar', premise_type: 'wrong_setting', ending_type: 'reversal' }] }, agent.plaintext);
  const a2 = await call('brief_approve', { id: b2.result.results[0].brief_id, punchline: 'A' }, approver.plaintext);
  const ep2 = a2.result.episode_id;
  await P.prepareScript(db, ep2, { apiKey: null, usdInrRate: 88 });
  // prepareScript re-syncs the cast from the bible (whose references are placeholders), so the
  // harness re-seeds Pip's reference — the bible is the source of truth in production.
  await client.query(`update characters set external_ref_id = 'ref_pip', driver = 'fal', reference_urls = $2 where channel_id = $1 and slug = 'pip'`, [BUREAU_CHANNEL_ID, [vendorUrl.replace('clip.mp4', 'pip.png')]]);
  await P.planShots(db, ep2, { usdInrRate: 88, actedBeatAvailable: false });
  const wrongVoice = await P.voiceStep(db, ep2, { usdInrRate: 88, apiKeyFor: async () => 'k', synth: synthFrom(() => 'Calendars drift because a year is not a whole number of days at all.'), align: (i) => alignLine(i), putBytes, presign, routeFor });
  check(!wrongVoice.ok && wrongVoice.code === 'alignment_failed', 'the stage refuses: alignment not confident', wrongVoice.ok ? 'it passed' : wrongVoice.detail.slice(0, 120));
  const { rows: ep2row } = await client.query('select script_id from episodes where id = $1', [ep2]);
  const { rows: ep2shots } = await client.query(`select count(*) filter (where duration_source = 'derived_from_vo') d from shots where script_id = $1`, [ep2row[0].script_id]);
  check(Number(ep2shots[0].d) === 0, 'no shot is marked derived_from_vo');
  const { rows: blank } = await client.query(`select count(*) n from vo_takes where script_id = $1 and word_timings = '[]'::jsonb and asset_id is not null`, [ep2row[0].script_id]);
  check(Number(blank[0].n) > 0, 'the paid-for audio is kept, with null timings — not zeros');
  const q2 = await P.enqueueGeneration(db, ep2, { usdInrRate: 88 });
  check(q2.queued === 0 && q2.refused.some((r) => /still an estimate/.test(r)), 'LOAD-BEARING: the consumer refuses to generate', JSON.stringify(q2.refused));
  const { rows: blk } = await client.query('select blocker from v_pipeline_blockers where script_id = $1', [ep2row[0].script_id]);
  check(/forced alignment did not confirm every word/.test(blk[0]?.blocker ?? ''), 'the blocker view names the failed alignment as the reason', blk[0]?.blocker);
  const { rows: blk1 } = await client.query('select blocker from v_pipeline_blockers where script_id = $1', [script1.scriptId]);
  check(blk1[0]?.blocker === null, 'and for the episode that went through, the view says nothing blocks it', String(blk1[0]?.blocker));
} catch (err) {
  check(false, 'harness threw', err.stack);
} finally {
  mcp.close();
  vendor.close();
  await new Promise((r) => s3.close(r));
  await scratch.release();
  await rm(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED\n` : '\nThe definition of done holds end to end.\n');
process.exit(failures ? 1 : 0);
