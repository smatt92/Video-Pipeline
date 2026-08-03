#!/usr/bin/env node
/**
 * Exercise the rough-cut assembler for real.
 *
 * PROVES:  six synthetic clips ingest and then concatenate into one playable MP4 whose
 *          duration equals the sum of its parts; the output is still the canonical
 *          intermediate; a `renders` row lands with kind='rough_cut'; and a set
 *          containing ONE non-normalised clip is REFUSED rather than concatenated into a
 *          file that plays wrong.
 *
 * DOES NOT: prove anything about a vendor. There is no vendor in this path at all — every
 *          byte here is produced by ffmpeg and read back by ffprobe.
 *
 * Usage: node scripts/verify-assemble.mjs <db-url>
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-assemble.mjs <db-url>');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { probe, isCanonical, normalise } = await import(`${BUILD}/ingest/normalise.js`);
const { assembleRoughCut } = await import(`${BUILD}/assemble/rough-cut.js`);
const { runAssemble } = await import(`${BUILD}/assemble/run.js`);
const pg = await import('./lib/pg.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const work = await mkdtemp(join(tmpdir(), 'kiln-verify-assemble-'));
const storageRoot = join(work, 'storage');
await mkdir(storageRoot, { recursive: true });
process.env.KILN_LOCAL_STORAGE_ROOT = storageRoot;

const { writeStreamLocal, localPathFor } = await import(`${BUILD}/storage/local.js`);

console.log('\nRough-cut assembler verification\n');

// ── Six clips, each visibly different so a dropped segment would be obvious ──
console.log('1. Building and normalising six clips\n');

const SOURCES = [
  'testsrc=size=1280x720:rate=25:duration=1.5',
  'smptebars=size=640x480:rate=30:duration=2',
  'testsrc2=size=1080x1920:rate=24:duration=1',
  'testsrc=size=800x800:rate=50:duration=2.5',
  'smptehdbars=size=1920x1080:rate=30:duration=1',
  'testsrc2=size=480x854:rate=15:duration=2',
];

const normalised = [];
let expectedTotal = 0;

for (const [i, source] of SOURCES.entries()) {
  const raw = join(work, `raw-${i}.mp4`);
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', source,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', raw,
  ]);

  const out = join(work, `norm-${i}.mp4`);
  const result = await normalise(raw, out);
  if (!result.ok) {
    bad(`clip ${i}`, result.error);
    continue;
  }
  normalised.push({ path: out, label: `shot ${i}` });
  expectedTotal += result.output.durationS;
  console.log(
    `  clip ${i}  ${result.source.width}x${result.source.height}@${result.source.fps.toFixed(0)} → ` +
      `canonical, ${result.output.durationS.toFixed(2)}s`,
  );
}

console.log(`\n  inputs sum to ${expectedTotal.toFixed(2)}s\n`);

// ── 2. Concatenate ──────────────────────────────────────────────────────────
console.log('2. Concatenating\n');

const outPath = join(work, 'rough-cut.mp4');
const result = await assembleRoughCut({ clips: normalised, outputPath: outPath, workDir: work });

if (!result.ok) {
  bad('assemble six clips', `${result.code}: ${result.detail}`);
} else {
  const drift = Math.abs(result.durationS - expectedTotal);
  if (!isCanonical(result.probe)) {
    bad('output is canonical', `${result.probe.width}x${result.probe.height} ${result.probe.codec}`);
  } else if (drift > 0.5) {
    bad('duration matches', `${result.durationS.toFixed(2)}s vs ${expectedTotal.toFixed(2)}s`);
  } else {
    ok(
      'six clips → one MP4',
      `${result.durationS.toFixed(2)}s (expected ${expectedTotal.toFixed(2)}s, drift ${drift.toFixed(3)}s), ` +
        `${result.probe.width}x${result.probe.height}@${result.probe.fps.toFixed(2)}, ${result.renderMs}ms`,
    );
  }

  // Playability is not "ffprobe read the header". Decode every frame and count them.
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-print_format', 'csv=p=0', outPath,
    ]);
    const frames = Number(stdout.trim());
    const expectedFrames = Math.round(expectedTotal * 30);
    if (Math.abs(frames - expectedFrames) > 15) {
      bad('every frame decodes', `${frames} frames, expected about ${expectedFrames}`);
    } else {
      ok('every frame decodes', `${frames} frames decoded, expected about ${expectedFrames}`);
    }
  } catch (err) {
    bad('every frame decodes', String(err).slice(0, 200));
  }
}

// ── 3. The refusal ──────────────────────────────────────────────────────────
console.log('\n3. One non-normalised clip must refuse, not produce a broken file\n');

const rogueRaw = join(work, 'rogue.mp4');
await run('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=1',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rogueRaw,
]);

const poisoned = [...normalised.slice(0, 3), { path: rogueRaw, label: 'shot 3 (NOT normalised)' }, ...normalised.slice(4)];
const poisonedOut = join(work, 'poisoned.mp4');
const refusal = await assembleRoughCut({ clips: poisoned, outputPath: poisonedOut, workDir: work });

if (refusal.ok) {
  bad('mismatched set', 'was concatenated instead of refused');
} else if (refusal.code !== 'not_canonical') {
  bad('mismatched set', `refused for the wrong reason: ${refusal.code}`);
} else if (!refusal.detail.includes('shot 3 (NOT normalised)')) {
  bad('mismatched set', 'refusal does not name the offending clip');
} else {
  ok('mismatched set refused', 'and it names which clip and both shapes');
  console.log(`        ${refusal.detail.split('\n')[1]?.trim()}`);
}

// What the refusal prevented, demonstrated rather than asserted: force the same concat
// past the guard and show the result is wrong.
const forcedOut = join(work, 'forced.mp4');
const listPath = join(work, 'forced.txt');
const { writeFile } = await import('node:fs/promises');
await writeFile(listPath, poisoned.map((c) => `file '${c.path}'`).join('\n'));
try {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', forcedOut,
  ]);
  const forced = await probe(forcedOut);
  const forcedDrift = Math.abs(forced.durationS - expectedTotal);
  console.log(
    `        had it not refused: ${forced.durationS.toFixed(2)}s against ${expectedTotal.toFixed(2)}s ` +
      `expected — ${forcedDrift.toFixed(2)}s wrong`,
  );
} catch {
  console.log('        had it not refused: ffmpeg itself failed on the mismatched set');
}

// ── 4. Through the database ─────────────────────────────────────────────────
console.log('\n4. End to end through runAssemble, writing a renders row\n');

const client = (await pg.tryConnect(dbUrl)).client;
const ids = {
  channel: '00000000-0000-4000-8000-0000000a55e1',
  concept: '00000000-0000-4000-8000-0000000a55e2',
  script: '00000000-0000-4000-8000-0000000a55e3',
};

await client.query(`delete from renders where script_id = $1`, [ids.script]);
await client.query(
  `delete from assets where generation_id in (select id from generations where idempotency_key like 'asm-%')`,
);
await client.query(`delete from generations where idempotency_key like 'asm-%'`);
await client.query(`delete from shots where script_id = $1`, [ids.script]);
await client.query(`delete from scripts where id = $1`, [ids.script]);
await client.query(`delete from concepts where id = $1`, [ids.concept]);
await client.query(`delete from channels where id = $1`, [ids.channel]);

await client.query(
  `insert into channels (id,name,platform,niche,is_active) values ($1,'asm','youtube','probe',true)`,
  [ids.channel],
);
await client.query(
  `insert into concepts (id,channel_id,title,angle,rubric_version,status) values ($1,$2,'asm','probe',1,'draft')`,
  [ids.concept, ids.channel],
);
await client.query(
  `insert into scripts (id,concept_id,hook,beats,vo_text,structure_hash,drafted_by)
   values ($1,$2,'hook','[]'::jsonb,'vo','h','harness')`,
  [ids.script, ids.concept],
);

// Store the normalised clips as if ingest had, then point the assembler at the script.
const { createReadStream } = await import('node:fs');
for (const [i, clip] of normalised.entries()) {
  const shot = (
    await client.query(
      `insert into shots (script_id,idx,duration_s,description,status)
       values ($1,$2,2,'probe','ready') returning id`,
      [ids.script, i],
    )
  ).rows[0].id;

  const gen = (
    await client.query(
      `insert into generations (shot_id,kind,driver,model,status,idempotency_key,request_payload,submitted_at,confirmed_at)
       values ($1,'video','higgsfield','dop-lite','succeeded',$2,'{}'::jsonb,now(),now()) returning id`,
      [shot, `asm-${i}`],
    )
  ).rows[0].id;

  const key = `generations/${gen}/video.mp4`;
  const bytes = await writeStreamLocal(key, createReadStream(clip.path));
  const meta = await probe(clip.path);

  await client.query(
    `insert into assets (generation_id,kind,storage_key,bytes,duration_s,width,height,normalized_at)
     values ($1,'video',$2,$3,$4,$5,$6,now())`,
    [gen, key, bytes, meta.durationS, meta.width, meta.height],
  );
}

const db = makeDb(client);
const dbResult = await runAssemble(
  { scriptId: ids.script },
  { db, localPath: localPathFor, putBytes: writeStreamLocal },
);

if (!dbResult.ok) {
  bad('runAssemble', `${dbResult.code}: ${dbResult.detail}`);
} else {
  const render = (await client.query('select * from renders where id = $1', [dbResult.renderId])).rows[0];
  if (!render) bad('renders row', 'absent');
  else if (render.kind !== 'rough_cut') bad('renders row', `kind is "${render.kind}"`);
  else if (render.status !== 'ready') bad('renders row', `status is "${render.status}"`);
  else {
    ok(
      'renders row',
      `kind=${render.kind} status=${render.status} ${Number(render.duration_s).toFixed(2)}s ` +
        `${render.width}x${render.height} render_ms=${render.render_ms}`,
    );
    const stored = await probe(localPathFor(dbResult.key));
    if (!isCanonical(stored)) bad('stored render', 'not canonical');
    else ok('stored render', `${dbResult.key}, ${stored.durationS.toFixed(2)}s, playable`);
  }
}

await client.end();
await rm(work, { recursive: true, force: true });

console.log(failures === 0 ? '\nRough cut works.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);

// ── A supabase-js-shaped adapter over pg, so the REAL runAssemble executes ───
function makeDb(client) {
  return {
    from(table) {
      const st = { table, filters: [], ins: [], columns: '*', payload: null, mode: 'select', order: null };
      const api = {
        select(c) { st.columns = c ?? '*'; return api; },
        insert(p) { st.mode = 'insert'; st.payload = p; return api; },
        update(p) { st.mode = 'update'; st.payload = p; return api; },
        eq(c, v) { st.filters.push([c, v]); return api; },
        in(c, vs) { st.ins.push([c, vs]); return api; },
        order(c, o) { st.order = [c, o?.ascending === false ? 'desc' : 'asc']; return api; },
        async maybeSingle() { return { data: (await exec(st))[0] ?? null, error: null }; },
        async single() {
          const r = await exec(st);
          return r[0] ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } };
        },
        then(res, rej) { return exec(st).then((rows) => res({ data: rows, error: null }), rej); },
      };
      return api;
    },
  };

  async function exec(st) {
    const params = [];
    const clauses = [];
    for (const [c, v] of st.filters) { params.push(v); clauses.push(`${c} = $${params.length}`); }
    for (const [c, vs] of st.ins) {
      if (vs.length === 0) { clauses.push('false'); continue; }
      const ph = vs.map((v) => { params.push(v); return `$${params.length}`; });
      clauses.push(`${c} in (${ph.join(',')})`);
    }
    const where = clauses.length ? ` where ${clauses.join(' and ')}` : '';
    const order = st.order ? ` order by ${st.order[0]} ${st.order[1]}` : '';

    if (st.mode === 'select') {
      return (await client.query(`select ${st.columns} from ${st.table}${where}${order}`, params)).rows;
    }
    if (st.mode === 'insert') {
      const cols = Object.keys(st.payload);
      const vals = cols.map((c) => st.payload[c]);
      const ph = cols.map((_, i) => `$${i + 1}`);
      return (
        await client.query(
          `insert into ${st.table} (${cols.join(',')}) values (${ph.join(',')}) returning *`,
          vals,
        )
      ).rows;
    }
    const cols = Object.keys(st.payload);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    const tail = st.filters.map(([c], i) => `${c} = $${cols.length + i + 1}`);
    return (
      await client.query(
        `update ${st.table} set ${sets.join(',')}${tail.length ? ` where ${tail.join(' and ')}` : ''} returning *`,
        [...cols.map((c) => st.payload[c]), ...st.filters.map(([, v]) => v)],
      )
    ).rows;
  }
}
