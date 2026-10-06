#!/usr/bin/env node
/**
 * verify:runway-video — the character-beat path on the Runway API, driven through the real
 * driver, the real dispatcher and the real ingest (decision 0015).
 *
 * PROVES, every run (§1, a local stand-in for the vendor's HTTP surface):
 *   - the estimate for a 4.6 s character beat is ONE 5 s gen4_turbo call at the rate_card
 *     row 0044 seeds — the expected figure is read from the table and multiplied by hand,
 *     not computed by the code under test;
 *   - the dispatcher writes the cost_ledger estimate BEFORE the vendor is called, at the
 *     billed length, keyed to the job's idempotency key, and a second dispatch submits
 *     nothing;
 *   - the request body the real driver builds: gen4_turbo, 720:1280, duration 5, the locked
 *     frame (resolved from storage for this call only) as the first frame, no audio key;
 *   - the job's status transition queued → submitted → (still submitted while the task
 *     RUNs) → succeeded, and the shot → ready;
 *   - the vendor's reported final charge lands as a `reconcile` row with cost_source
 *     'measured';
 *   - ffprobe of the STORED file: exactly 150 video packets (5 s at the canonical 30 fps) —
 *     a frame count, never the container's duration (CLAUDE.md, verify:render).
 *
 * PROVES, only when RUNWAY_API_KEY is set (§2, the real vendor, one clip, spend-limited):
 *   the same chain against api.dev.runwayml.com — one 5 s gen4_turbo clip from a placeholder
 *   9:16 frame, refused up front if it would cost more than --max-credits (default 25). The
 *   frame count is asserted within ±1 of 150 there, and only there: the vendor decides its
 *   own frame count, and the first real run is what calibrates that (0008).
 *
 * When RUNWAY_API_KEY is absent §2 prints SKIP with that reason and the exit code reflects
 * §1 alone — unless --require-real, which turns the skip into a failure. It never prints a
 * PASS for a call that did not happen.
 *
 * `--frame <png>` replaces the placeholder with a real locked frame (≤ 5 MB) for §2, so the one
 * paid clip is also the first look at whether Gen-4 Turbo holds the character (0015).
 *
 * Usage: node scripts/verify-runway-video.mjs <db-url> [--require-real] [--max-credits 25] [--frame f.png]
 */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-runway-video.mjs <db-url> [--require-real] [--max-credits 25]');
  process.exit(2);
}
const requireReal = process.argv.includes('--require-real');
const maxCreditsArg = process.argv.indexOf('--max-credits');
const MAX_CREDITS = maxCreditsArg > -1 ? Number(process.argv[maxCreditsArg + 1]) : 25;
const frameArg = process.argv.indexOf('--frame');
const REAL_FRAME = frameArg > -1 ? process.argv[frameArg + 1] : null;

const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { submitJob, pollJob } = require(`${B}/drivers/jobs.js`);
const { RUNWAY_BASE } = require(`${B}/drivers/runway.js`);
const { dispatchProvider, advanceSubmitted } = require(`${B}/bureau/dispatch.js`);
const { estimateEpisode } = require(`${B}/bureau/estimate.js`);
const { BUREAU_CHANNEL_ID } = require(`${B}/bureau/bible.js`);
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

const work = await mkdtemp(join(tmpdir(), 'kiln-verify-runway-'));

// ── Storage: a real S3 surface, locally ──────────────────────────────────────
const S3Rver = (await import('s3rver')).default;
await mkdir(join(work, 's3'), { recursive: true });
const BUCKET = 'kiln-runway';
const s3 = new S3Rver({ port: 0, address: '127.0.0.1', silent: true, directory: join(work, 's3'), configureBuckets: [{ name: BUCKET }] });
const s3Addr = await new Promise((res, rej) => s3.run((err, a) => (err ? rej(err) : res(a))));
const storage = createSupabaseStorageDriver({ accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER', endpoint: `http://127.0.0.1:${s3Addr.port}`, bucket: BUCKET, region: 'us-east-1' });
const putBytes = async (key, body) => {
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  const bytes = Buffer.concat(chunks);
  const signed = await storage.presignPut({ key, contentType: 'video/mp4' });
  const r = await fetch(signed.url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': 'video/mp4' } });
  if (!r.ok) throw new Error(`PUT ${key} ${r.status}`);
  return bytes.length;
};
async function storedFrames(db, generationId) {
  const { data: asset } = await db.from('assets').select('storage_key').eq('generation_id', generationId).not('normalized_at', 'is', null).limit(1).maybeSingle();
  if (!asset) return { frames: null, why: 'no normalised asset row' };
  const r = await fetch((await storage.presignGet({ key: asset.storage_key, expiresIn: 300 })).url);
  const out = join(work, `${generationId}.mp4`);
  await writeFile(out, Buffer.from(await r.arrayBuffer()));
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets,width,height', '-of', 'json', out]);
  const s = JSON.parse(stdout).streams[0];
  return { frames: Number(s.nb_read_packets), width: s.width, height: s.height };
}

// ── The placeholder locked frame: a 9:16 navy card with a chalk stick figure ──
const framePng = join(work, 'frame.png');
await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0B1F3A:s=720x1280:d=1', '-frames:v', '1',
  '-vf', 'drawbox=x=340:y=360:w=40:h=40:color=0xF4F1E8:t=4,drawbox=x=358:y=400:w=4:h=260:color=0xF4F1E8:t=fill,drawbox=x=280:y=470:w=160:h=4:color=0x2EC4F1:t=fill,drawbox=x=330:y=660:w=4:h=200:color=0xF4F1E8:t=fill,drawbox=x=386:y=660:w=4:h=200:color=0xF4F1E8:t=fill',
  framePng]);
const frameUri = `data:image/png;base64,${(await readFile(framePng)).toString('base64')}`;
const FRAME_KEY = 'characters/pip/ref-verify.png';

// ── DB ───────────────────────────────────────────────────────────────────────
const scratch = await scratchDatabase(dbUrl, 'runway');
const client = scratch.client;
const db = supabaseShim(client);

/** One character-beat job, built by the code under test from a 4.6 s shot. */
async function makeJob(tag) {
  const { rows: cc } = await client.query(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, $2, 'a', 'bureau-v1', 'in_production') returning id`, [BUREAU_CHANNEL_ID, `runway-${tag}`]);
  const { rows: ss } = await client.query(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'vo', 'verify', $2) returning id`, [cc[0].id, `h-${tag}`]);
  const { rows: sh } = await client.query(`insert into shots (script_id, idx, duration_s, description, render_route, character_slugs, status) values ($1, 0, 4.6, 'Pip turns, clipboard falls', 'character_beat', '{pip}', 'generating') returning id`, [ss[0].id]);
  const est = await estimateEpisode(db, { shots: [{ route: 'character_beat', description: 'Pip turns, clipboard falls', duration_s: 4.6, characters: ['pip'], realistic: false }], voChars: 0, usdInrRate: 88 });
  const line = est.shots[0];
  const params = { max_duration_s: 10, prompt: 'Pip turns; the clipboard falls. Chalk lines on navy.', aspect_ratio: '9:16', duration_s: line.billed_s, reference_frame: `storage:${FRAME_KEY}` };
  const { rows: job } = await client.query(
    `insert into gen_jobs (shot_id, render_route, provider, model, params, duration_s, estimate_inr, idempotency_key) values ($1, 'character_beat', 'runway', 'gen4_turbo', $2, 4.6, $3, $4) returning id`,
    [sh[0].id, JSON.stringify(params), line.inr, `verify-runway:${tag}`],
  );
  return { jobId: job[0].id, shotId: sh[0].id, line };
}
const jobRow = async (id) => (await client.query('select j.status, j.request_id, j.generation_id, g.external_job_id, s.status shot_status from gen_jobs j left join generations g on g.id = j.generation_id left join shots s on s.id = j.shot_id where j.id = $1', [id])).rows[0];

let vendor = null;
try {
  // Inputs: an active gen4_turbo recipe (0044 seeds it retired, on purpose), the generation key.
  await client.query(`insert into prompts (name, driver, model, template, params, tags, discovered_in, is_active, accepts_character_ref) values ('verify-gen4', 'runway', 'gen4_turbo', '{{description}}', '{"max_duration_s": 10}', '{subject_medium}', 'manual', true, true)`);
  const { rows: rate } = await client.query(`select unit_cost from rate_card where driver = 'runway' and model = 'gen4_turbo' and unit = 'second' and endpoint is null and is_verified`);
  const RATE = Number(rate[0]?.unit_cost);

  // ═══ §1 The driver against a local stand-in for the vendor ═══
  console.log('\n§1 The real driver, dispatcher and ingest against a local vendor surface\n');
  const clip = join(work, 'vendor.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=24:duration=5', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip]);
  const seen = { starts: [], reads: 0 };
  vendor = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/image_to_video') {
        seen.starts.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'task_verify_1', estimatedCost: { credits: 25 } }));
      } else if (req.method === 'GET' && req.url === '/v1/tasks/task_verify_1') {
        seen.reads++;
        const done = seen.reads >= 2;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(done
          ? { id: 'task_verify_1', status: 'SUCCEEDED', createdAt: '2026-10-06T00:00:00Z', output: [`http://127.0.0.1:${vendor.address().port}/clip.mp4`], cost: { credits: 25 } }
          : { id: 'task_verify_1', status: 'RUNNING', createdAt: '2026-10-06T00:00:00Z', estimatedCost: { credits: 25 } }));
      } else if (req.url === '/clip.mp4') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        createReadStream(clip).pipe(res);
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  await new Promise((r) => vendor.listen(0, '127.0.0.1', r));
  const local = `http://127.0.0.1:${vendor.address().port}/v1`;
  // The driver always addresses RUNWAY_BASE; the harness reroutes that host and nothing else.
  const routed = (url, init) => fetch(String(url).startsWith(RUNWAY_BASE) ? String(url).replace(RUNWAY_BASE, local) : url, init);

  const presigned = [];
  const deps = {
    db, worker: 'verify-runway', usdInrRate: 88,
    credentialsFor: async () => ({ ok: true, values: { RUNWAY_API_KEY: 'stub-key' } }),
    presign: async (key) => { presigned.push(key); return frameUri; },
    submit: (i) => submitJob({ ...i, fetchImpl: routed }),
    poll: (i) => pollJob({ ...i, fetchImpl: routed }),
    ingest: ({ generationId, assetUrl }) => runIngest({ generationId, assetUrl }, { db, putBytes }),
  };

  const j1 = await makeJob('stub');
  check(j1.line.billed_s === 5 && j1.line.inr === Math.round(5 * RATE * 88 * 100) / 100,
    'a 4.6 s beat is priced as ONE 5 s gen4_turbo call at the 0044 rate (5 × $0.05 × ₹88)', `${j1.line.billed_s}s, ₹${j1.line.inr}`);
  check(j1.line.planned_inr === Math.round(5 * RATE * 1.5 * 88 * 100) / 100, 'and planned at 1.5× for re-rolls (the figure the cap fitter uses)', `₹${j1.line.planned_inr}`);
  check((await jobRow(j1.jobId)).status === 'queued', 'the job starts queued');

  const d1 = await dispatchProvider('runway', 3, deps);
  const after1 = await jobRow(j1.jobId);
  check(d1.submitted === 1 && after1.status === 'submitted' && after1.request_id === 'task_verify_1' && after1.external_job_id === 'task_verify_1',
    'queued → submitted, with the vendor task id on the job and the generation', JSON.stringify(after1));
  const body = seen.starts[0]?.body ?? {};
  check(body.model === 'gen4_turbo' && body.ratio === '720:1280' && body.duration === 5 && !('audio' in body),
    'the driver sent gen4_turbo, 720:1280, 5 s, and no audio key', JSON.stringify({ ...body, promptImage: '…' }));
  check(Array.isArray(body.promptImage) && body.promptImage[0]?.position === 'first' && body.promptImage[0]?.uri === frameUri && presigned[0] === FRAME_KEY,
    'the locked frame was resolved from storage for this call and sent as the first frame');
  check(seen.starts[0]?.headers['x-runway-version'] === '2024-11-06' && seen.starts[0]?.headers.authorization === 'Bearer stub-key', 'with the version header and the key');
  const { rows: est1 } = await client.query(`select entry_kind, cost_source, unit, quantity, cost_inr, idempotency_key from cost_ledger where generation_id = $1`, [after1.generation_id]);
  check(est1.length === 1 && est1[0].entry_kind === 'estimate' && est1[0].cost_source === 'rate_card' && Number(est1[0].quantity) === 5 && Number(est1[0].cost_inr) === j1.line.inr && est1[0].idempotency_key === 'verify-runway:stub:estimate',
    'one ledger estimate, written at submit, for the 5 billed seconds', JSON.stringify(est1[0]));
  check((await client.query('select params from gen_jobs where id = $1', [j1.jobId])).rows[0].params.image_url === undefined, 'the resolved frame was not written back to the job');
  const d2 = await dispatchProvider('runway', 3, deps);
  check(d2.claimed === 0 && seen.starts.length === 1, 'a second dispatch claims nothing and submits nothing');

  await advanceSubmitted('runway', deps);
  check((await jobRow(j1.jobId)).status === 'submitted', 'while the task RUNs, the job stays submitted');
  await advanceSubmitted('runway', deps);
  const after3 = await jobRow(j1.jobId);
  check(after3.status === 'succeeded' && after3.shot_status === 'ready', 'submitted → succeeded once the task SUCCEEDs; the shot is ready', JSON.stringify(after3));
  const { rows: rec1 } = await client.query(`select cost_source, unit, quantity, cost_inr from cost_ledger where generation_id = $1 and entry_kind = 'reconcile'`, [after1.generation_id]);
  check(rec1.length === 1 && rec1[0].cost_source === 'measured' && rec1[0].unit === 'credit' && Number(rec1[0].quantity) === 25 && Math.abs(Number(rec1[0].cost_inr) - 25 * 0.01 * 88) < 1e-9,
    'the task’s reported final charge is a measured reconcile (25 credits)', JSON.stringify(rec1[0]));
  const f1 = await storedFrames(db, after1.generation_id);
  check(f1.frames === 150 && f1.width === 1080 && f1.height === 1920, 'ffprobe of the stored file: 150 frames (5 s at 30 fps), 1080×1920', JSON.stringify(f1));

  // ═══ §2 The real vendor ═══
  console.log('\n§2 One real gen4_turbo clip on the Runway API\n');
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) {
    const msg = 'SKIP  §2 — RUNWAY_API_KEY is not set, so no real call was made. Nothing above proves the vendor accepts these requests; 0008 lists it as unverified.';
    if (requireReal) check(false, '--require-real was given', msg);
    else console.log(`  ${msg}`);
  } else {
    const j2 = await makeJob('real');
    const credits = 5 * 5;
    if (credits > MAX_CREDITS) {
      check(false, `refused before spending: ${credits} credits is over --max-credits ${MAX_CREDITS}`);
    } else {
      const realUri = REAL_FRAME ? `data:image/png;base64,${(await readFile(REAL_FRAME)).toString('base64')}` : frameUri;
      if (realUri.length > 5 * 1024 * 1024 * 1.37) throw new Error(`${REAL_FRAME} is over the vendor's 5 MB image limit`);
      console.log(`  INFO  frame: ${REAL_FRAME ?? 'the placeholder navy card'}`);
      const realDeps = { ...deps, presign: async () => realUri, credentialsFor: async () => ({ ok: true, values: { RUNWAY_API_KEY: apiKey } }), submit: submitJob, poll: pollJob };
      const r1 = await dispatchProvider('runway', 1, realDeps);
      const s1 = await jobRow(j2.jobId);
      check(r1.submitted === 1 && s1.status === 'submitted' && !!s1.request_id, 'the vendor accepted the task; the job is submitted', JSON.stringify({ ...s1, error: (await client.query('select last_error from gen_jobs where id = $1', [j2.jobId])).rows[0].last_error }));
      const { rows: est2 } = await client.query(`select entry_kind, quantity, cost_inr from cost_ledger where generation_id = $1`, [s1.generation_id]);
      check(est2.length === 1 && est2[0].entry_kind === 'estimate' && Number(est2[0].quantity) === 5, 'the estimate was ledgered at submit', JSON.stringify(est2[0]));
      const deadline = Date.now() + 10 * 60_000;
      let st = s1;
      while (st.status === 'submitted' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10_000));
        await advanceSubmitted('runway', realDeps);
        st = await jobRow(j2.jobId);
      }
      check(st.status === 'succeeded' && st.shot_status === 'ready', 'submitted → succeeded on the real vendor; the clip is ingested', JSON.stringify(st));
      const { rows: rec2 } = await client.query(`select quantity, cost_source from cost_ledger where generation_id = $1 and entry_kind = 'reconcile'`, [s1.generation_id]);
      console.log(`  INFO  vendor-reported charge: ${rec2[0] ? `${rec2[0].quantity} credits (${rec2[0].cost_source})` : 'none in the task — no reconcile written, the estimate stands, labelled'}`);
      if (st.status === 'succeeded') {
        const f2 = await storedFrames(db, s1.generation_id);
        check(f2.frames !== null && Math.abs(f2.frames - 150) <= 1, 'ffprobe of the stored file: 150 ± 1 frames (the vendor sets its own count; first real run calibrates)', JSON.stringify(f2));
        const { data: a } = await db.from('assets').select('storage_key').eq('generation_id', s1.generation_id).limit(1).maybeSingle();
        const keep = join(process.cwd(), 'out', 'runway-video-real.mp4');
        await mkdir(join(process.cwd(), 'out'), { recursive: true });
        await writeFile(keep, Buffer.from(await (await fetch((await storage.presignGet({ key: a.storage_key, expiresIn: 300 })).url)).arrayBuffer()));
        console.log(`  INFO  the clip, to watch: ${keep}`);
      }
    }
  }
} catch (err) {
  check(false, 'harness threw', err.stack);
} finally {
  vendor?.close();
  await new Promise((r) => s3.close(r));
  await scratch.release();
  await rm(work, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED\n` : '\nverify:runway-video passed.\n');
process.exit(failures ? 1 : 0);
