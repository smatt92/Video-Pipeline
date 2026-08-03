#!/usr/bin/env node
/**
 * Exercise the ingest path for real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROVES:  three genuinely different inputs — different resolutions, framerates, codecs,
 *          aspect ratios and audio presence — all normalise to the one canonical
 *          intermediate; a corrupt input writes `normalize_error` and NO `assets` row;
 *          the stored object is re-probed rather than assumed; the row carries
 *          `normalized_at` and the source's real shape in `source_meta`.
 *
 * DOES NOT: prove the vendor's own URL behaves like this local one. That is the single
 *          unverifiable step and it is the only one — everything after the fetch runs
 *          against real ffmpeg, a real driver write and a real database.
 *
 * The clips are made with ffmpeg's own `testsrc`/`smptebars` generators and served over
 * plain HTTP from this process, so the ingest code performs an actual network fetch. It
 * is not handed a file path.
 *
 * Usage: node scripts/verify-ingest.mjs <db-url>
 */

import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-ingest.mjs <db-url>');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;

const { probe, isCanonical, CANONICAL } = await import(`${BUILD}/ingest/normalise.js`);
const { runIngest } = await import(`${BUILD}/ingest/run.js`);


// ── Fixtures: three clips nothing about which is canonical ──────────────────
const CLIPS = [
  {
    name: 'landscape-1080p-24fps-h264',
    args: (out) => [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=24:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out,
    ],
  },
  {
    name: 'square-720-60fps-mpeg4-no-audio',
    args: (out) => [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'smptebars=size=720x720:rate=60:duration=2',
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', out,
    ],
  },
  {
    name: 'tall-540x960-29.97fps-vp9-yuv444',
    args: (out) => [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30000/1001:duration=2',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv444p', '-b:v', '500k', out,
    ],
  },
];

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  failures++;
};

const work = await mkdtemp(join(tmpdir(), 'kiln-verify-ingest-'));
const storageRoot = join(work, 'storage');
await mkdir(storageRoot, { recursive: true });
process.env.KILN_LOCAL_STORAGE_ROOT = storageRoot;

const { writeStreamLocal, localPathFor } = await import(`${BUILD}/storage/local.js`);

console.log('\nIngest verification\n');

// ── Build the clips ─────────────────────────────────────────────────────────
console.log('Building synthetic inputs with ffmpeg:');
const built = [];
for (const clip of CLIPS) {
  const path = join(work, `${clip.name}.${clip.name.includes('vp9') ? 'webm' : 'mp4'}`);
  await run('ffmpeg', clip.args(path), { maxBuffer: 8 * 1024 * 1024 });
  const meta = await probe(path);
  built.push({ ...clip, path, meta });
  console.log(
    `  ${clip.name.padEnd(38)} ${meta.width}x${meta.height} ${meta.fps.toFixed(2)}fps ` +
      `${meta.codec}/${meta.pixFmt} audio=${meta.hasAudio}`,
  );
  if (isCanonical(meta)) bad(`${clip.name} is already canonical`, 'the fixture proves nothing');
}

// A file that is not a video at all.
const corruptPath = join(work, 'corrupt.mp4');
await createWriteStream(corruptPath).end(Buffer.from('not an mp4, just some bytes'.repeat(40)));

// ── Serve them ──────────────────────────────────────────────────────────────
const files = new Map(built.map((b) => [`/${b.name}`, b.path]));
files.set('/corrupt', corruptPath);

const server = createServer((req, res) => {
  const path = files.get(req.url ?? '');
  if (!path) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'video/mp4' });
  createReadStream(path).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`\nServing them over HTTP at ${base}\n`);

// ── Database fixture ────────────────────────────────────────────────────────
const { scratchDatabase } = await import('./lib/scratch.mjs');
const scratch = await scratchDatabase(dbUrl, 'ingest');
const client = scratch.client;
if (!client) {
  console.error('could not connect to the database');
  process.exit(1);
}

const ids = {
  // Hex only — "ing" is not a uuid, which Postgres said clearly and immediately.
  channel: '00000000-0000-4000-8000-00000015e001',
  concept: '00000000-0000-4000-8000-00000015e002',
  script: '00000000-0000-4000-8000-00000015e003',
};

await client.query(`delete from assets where generation_id in (select id from generations where idempotency_key like 'ingest-probe-%')`);
await client.query(`delete from generations where idempotency_key like 'ingest-probe-%'`);
await client.query(`delete from shots where script_id = $1`, [ids.script]);
await client.query(`delete from scripts where id = $1`, [ids.script]);
await client.query(`delete from concepts where id = $1`, [ids.concept]);
await client.query(`delete from channels where id = $1`, [ids.channel]);

await client.query(
  `insert into channels (id, name, platform, niche, is_active) values ($1,'ingest probe','youtube','probe',true)`,
  [ids.channel],
);
await client.query(
  `insert into concepts (id, channel_id, title, angle, rubric_version, status)
   values ($1,$2,'ingest probe','probe',1,'draft')`,
  [ids.concept, ids.channel],
);
await client.query(
  `insert into scripts (id, concept_id, hook, beats, vo_text, structure_hash, drafted_by)
   values ($1,$2,'hook','[]'::jsonb,'vo','h','harness')`,
  [ids.script, ids.concept],
);

// The supabase-js shape, over pg. The ingest code only ever calls .from().select()/
// .insert()/.update(), so this adapter is small — and it means the REAL runIngest runs,
// not a copy of it.
const db = {
  from(table) {
    const state = { table, filters: [], columns: '*', payload: null, mode: 'select' };
    const api = {
      select(columns) {
        state.columns = columns ?? '*';
        return api;
      },
      insert(payload) {
        state.mode = 'insert';
        state.payload = payload;
        return api;
      },
      update(payload) {
        state.mode = 'update';
        state.payload = payload;
        return api;
      },
      eq(column, value) {
        state.filters.push([column, value]);
        return api;
      },
      async maybeSingle() {
        const rows = await exec(state);
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const rows = await exec(state);
        return rows[0]
          ? { data: rows[0], error: null }
          : { data: null, error: { message: 'no rows' } };
      },
      then(resolve, reject) {
        return exec(state).then((rows) => resolve({ data: rows, error: null }), reject);
      },
    };
    return api;
  },
};

async function exec(state) {
  const where = state.filters.map(([c], i) => `${c} = $${i + 1}`).join(' and ');
  const values = state.filters.map(([, v]) => v);

  if (state.mode === 'select') {
    const sql = `select ${state.columns} from ${state.table}${where ? ` where ${where}` : ''}`;
    return (await client.query(sql, values)).rows;
  }

  if (state.mode === 'insert') {
    const cols = Object.keys(state.payload);
    const params = cols.map((_, i) => `$${i + 1}`);
    const sql =
      `insert into ${state.table} (${cols.join(',')}) values (${params.join(',')}) returning *`;
    return (await client.query(sql, cols.map((c) => state.payload[c]))).rows;
  }

  const cols = Object.keys(state.payload);
  const sets = cols.map((c, i) => `${c} = $${i + 1}`);
  const sql =
    `update ${state.table} set ${sets.join(',')}` +
    `${where ? ` where ${state.filters.map(([c], i) => `${c} = $${cols.length + i + 1}`).join(' and ')}` : ''}` +
    ' returning *';
  return (await client.query(sql, [...cols.map((c) => state.payload[c]), ...values])).rows;
}

async function makeGeneration(label, shotIdx) {
  const shot = (
    await client.query(
      `insert into shots (script_id, idx, duration_s, description, status)
       values ($1,$2,2,'probe','generating') returning id`,
      [ids.script, shotIdx],
    )
  ).rows[0].id;

  const gen = (
    await client.query(
      `insert into generations (shot_id, kind, driver, model, status, external_job_id,
                                idempotency_key, request_payload, submitted_at, confirmed_at, completed_at)
       values ($1,'video','higgsfield','dop-lite','succeeded',$2,$3,'{}'::jsonb, now(), now(), now())
       returning id`,
      [shot, `job-${label}`, `ingest-probe-${label}`],
    )
  ).rows[0].id;

  return { shot, gen };
}

// ── 1. Three shapes in, one shape out ───────────────────────────────────────
console.log('1. Three different inputs must all produce the canonical intermediate\n');

let idx = 0;
for (const clip of built) {
  const { gen } = await makeGeneration(clip.name, idx++);

  const result = await runIngest(
    { generationId: gen, assetUrl: `${base}/${clip.name}` },
    { db, putBytes: writeStreamLocal, localPath: localPathFor },
  );

  if (!result.ok) {
    bad(clip.name, `${result.code}: ${result.detail}`);
    continue;
  }

  const stored = await probe(localPathFor(result.key));
  const canonical = isCanonical(stored);

  const row = (await client.query('select * from assets where generation_id = $1', [gen])).rows[0];

  if (!canonical) {
    bad(clip.name, `stored file is ${stored.width}x${stored.height} ${stored.fps}fps ${stored.codec}`);
  } else if (!row) {
    bad(clip.name, 'no assets row');
  } else if (!row.normalized_at) {
    bad(clip.name, 'assets row has no normalized_at');
  } else if (!row.source_meta || row.source_meta.width !== clip.meta.width) {
    bad(clip.name, `source_meta does not carry the original shape: ${JSON.stringify(row.source_meta)}`);
  } else {
    ok(
      clip.name,
      `${clip.meta.width}x${clip.meta.height}@${clip.meta.fps.toFixed(2)} ${clip.meta.codec} → ` +
        `${stored.width}x${stored.height}@${stored.fps.toFixed(2)} ${stored.codec}/${stored.pixFmt}, ` +
        `${(row.bytes / 1024).toFixed(0)}kB, ${result.normaliseMs}ms`,
    );
  }
}

// ── 2. Corrupt input ────────────────────────────────────────────────────────
console.log('\n2. A corrupt input must write an error and NO asset\n');

const { gen: corruptGen } = await makeGeneration('corrupt', idx++);
const corruptResult = await runIngest(
  { generationId: corruptGen, assetUrl: `${base}/corrupt` },
  { db, putBytes: writeStreamLocal, localPath: localPathFor },
);

const corruptAssets = (
  await client.query('select count(*)::int as n from assets where generation_id = $1', [corruptGen])
).rows[0].n;
const corruptGenRow = (
  await client.query('select error_code, error_detail from generations where id = $1', [corruptGen])
).rows[0];

if (corruptResult.ok) bad('corrupt input', 'ingest reported success');
else if (corruptAssets !== 0) bad('corrupt input', `${corruptAssets} asset row(s) written`);
else if (corruptGenRow.error_code !== 'normalise_failed') {
  bad('corrupt input', `error_code is "${corruptGenRow.error_code}"`);
} else {
  ok('corrupt input', `no asset row, error_code=${corruptGenRow.error_code}`);
  console.log(`        detail: ${corruptGenRow.error_detail?.slice(0, 100)}`);
}

// ── 3. An unconfirmed generation must be refused ────────────────────────────
console.log('\n3. An unconfirmed generation must not be ingested at all\n');

const unconfirmedShot = (
  await client.query(
    `insert into shots (script_id, idx, duration_s, description, status)
     values ($1,$2,2,'probe','generating') returning id`,
    [ids.script, idx++],
  )
).rows[0].id;
const unconfirmedGen = (
  await client.query(
    `insert into generations (shot_id, kind, driver, model, status, external_job_id,
                              idempotency_key, request_payload, submitted_at)
     values ($1,'video','higgsfield','dop-lite','succeeded','job-unconfirmed',
             'ingest-probe-unconfirmed','{}'::jsonb, now()) returning id`,
    [unconfirmedShot],
  )
).rows[0].id;

const unconfirmedResult = await runIngest(
  { generationId: unconfirmedGen, assetUrl: `${base}/${built[0].name}` },
  { db, putBytes: writeStreamLocal, localPath: localPathFor },
);

if (unconfirmedResult.ok) bad('unconfirmed generation', 'was ingested');
else if (unconfirmedResult.code !== 'unconfirmed') {
  bad('unconfirmed generation', `refused for the wrong reason: ${unconfirmedResult.code}`);
} else ok('unconfirmed generation', 'refused before any fetch');

// ── Done ────────────────────────────────────────────────────────────────────
server.close();
await scratch.release();
await rm(work, { recursive: true, force: true });

console.log(
  failures === 0
    ? `\nIngest works. Canonical intermediate is ${CANONICAL.width}x${CANONICAL.height} ` +
        `${CANONICAL.fps}fps ${CANONICAL.vcodec}/${CANONICAL.pixFmt}.\n`
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
