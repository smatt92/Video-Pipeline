#!/usr/bin/env node
/**
 * pnpm probe:engineered — the 3D explainer's real checks on the HOSTED project (0052), after
 * bundle 10 is pasted. Two steps, each its own run; both write their cost rows exactly as
 * production does (rules 5 and 6) and stop at a rupee limit before anything moves.
 *
 *   --brief   Draft ONE brief for Built Like That from a bank topic (default B26, lift safety
 *             brakes) through the production writer — `draftBriefForSlot`, which takes the
 *             engineered branch because the series defaults to the 3D explainer — and store it
 *             with `createBriefs` as the system, with the embedder (so the repetition check
 *             RUNS and the brief is approvable) and the policy judge. It is left PENDING on
 *             Approvals: nothing is approved here, and the run spends only after Sahil approves.
 *             Spends one writer call (+ a judge call if the lint asks, + embeddings).
 *
 *   --proof   For that pending brief: ONE hero-object sheet (its first object) through the
 *             shared sheet path, then ONE 3D picture of the first scene beat that shows it —
 *             rewritten under 21-still.v6 and drawn WITH the sheet as its @Tag reference —
 *             then four graphics frames rendered over that picture by the real Remotion bundle
 *             (`probe:frame`). Spends two images (₹4.40 each at the 0044 rate) and one cheap
 *             rewrite. Prints the sheet, the picture and the frames as small JPEGs (base64) and
 *             writes them full size to ./out/engineered-probe/ (uploaded as a run artifact).
 *
 * `--max-inr` (default 15) refuses a step priced above it. Env: NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY, SUPABASE_S3_* (and the vault holds the vendor keys, as for the
 * worker). Needs `tsc -p tsconfig.verify.json` first.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { draftBriefForSlot, judgeLint } = require(`${B}/bureau/brief-generator.js`);
const { createBriefs } = require(`${B}/bureau/briefs.js`);
const { ledgeredEmbedder } = require(`${B}/bureau/embed.js`);
const { getBible } = require(`${B}/bureau/bible.js`);
const { engineeredLook, heroObjectsOf } = require(`${B}/bureau/engineered.js`);
const { makeSheetImage } = require(`${B}/bureau/sheet-core.js`);
const { stillPromptFor } = require(`${B}/bureau/stills.js`);
const { objectSheetPrompt, OBJECT_SHEET_PROMPT_REF } = require(`${B}/prompts/22-object-sheet.v1.js`);
const { requireCredential } = require(`${B}/integrations/credentials.js`);
const { verifiedCredential } = require(`${B}/integrations/verify.js`);
const { submitStill, waitStill, STILL_INTEGRATION, STILL_CREDENTIAL_FIELD, STILL_RATE_KEY, STILL_PROMPT_MAX, STILL_RATIO } = require(`${B}/drivers/still-image.js`);
const { createSupabaseStorageDriver } = require(`${B}/storage/supabase.js`);
const { createClient } = await import('@supabase/supabase-js');

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const step = process.argv.includes('--brief') ? 'brief' : process.argv.includes('--proof') ? 'proof' : null;
const maxInr = Number(arg('--max-inr', '15'));
const slotId = arg('--slot', 'B26');
if (!step) {
  console.error('usage: pnpm probe:engineered (--brief [--slot B26] | --proof) [--max-inr 15]');
  process.exit(2);
}
const need = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}`);
  process.exit(2);
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const base = process.env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const driver = createSupabaseStorageDriver({
  accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.SUPABASE_S3_SECRET_ACCESS_KEY,
  bucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'kiln-media',
  region: process.env.SUPABASE_S3_REGION ?? 'us-east-1',
  endpoint: process.env.SUPABASE_S3_ENDPOINT ?? `${base}/storage/v1/s3`,
});
const presign = async (key) => (await driver.presignGet({ key, expiresIn: 3600 })).url;
const putBytes = async (key, body) => {
  const chunks = [];
  for await (const x of body) chunks.push(Buffer.from(x));
  const bytes = Buffer.concat(chunks);
  const signed = await driver.presignPut({ key, contentType: 'image/png' });
  const res = await fetch(signed.url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': 'image/png' } });
  if (!res.ok) throw new Error(`PUT ${key}: HTTP ${res.status}`);
  return bytes.length;
};
const printJpeg = async (label, file, w, h) => {
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `scale=${w}:${h}`, '-q:v', '5', '/tmp/probe-small.jpg']);
  const b64 = (await readFile('/tmp/probe-small.jpg')).toString('base64');
  console.log(`----- BEGIN ${label} JPEG BASE64 (${w}x${h}) -----`);
  for (let i = 0; i < b64.length; i += 120) console.log(b64.slice(i, i + 120));
  console.log(`----- END ${label} JPEG BASE64 -----`);
};

const { data: ch } = await db.from('channels').select('id, name').eq('slug', 'built-like-that').maybeSingle();
if (!ch) {
  console.error('No channel built-like-that — paste docs/bureau/hosted-migrations-10-0052.sql first.');
  process.exit(2);
}
const cb = await getBible(db, ch.id);
const { data: fx } = await db.from('profiles').select('usd_inr_rate').not('usd_inr_rate', 'is', null).limit(1).single();
const usdInrRate = Number(fx.usd_inr_rate);
const { data: rate } = await db.from('rate_card').select('unit_cost, is_verified').eq('driver', STILL_RATE_KEY.driver).eq('model', STILL_RATE_KEY.model).eq('unit', STILL_RATE_KEY.unit).single();
const imageInr = Number(rate.unit_cost) * usdInrRate;
const llmKey = await requireCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');

if (step === 'brief') {
  const { data: pending } = await db.from('briefs').select('id, premise').eq('channel_id', ch.id).eq('status', 'pending');
  if (pending?.length) {
    console.error(`Built Like That already has ${pending.length} pending brief(s) (${pending.map((p) => p.id.slice(0, 8)).join(', ')}): one draft is the brief, so nothing is drafted. Approve or reject it on Approvals first.`);
    process.exit(1);
  }
  console.log(`Drafting ONE brief for ${ch.name} from slot ${slotId} (bible from ${cb.source}); ₹${usdInrRate}/USD`);
  const draft = await draftBriefForSlot(db, slotId, { db, apiKey: llmKey, usdInrRate, channelId: ch.id });
  if (!draft.ok) {
    console.error(`The draft was refused: ${draft.error}`);
    process.exit(1);
  }
  const [r] = await createBriefs([draft.brief], {
    db,
    token: { id: null, scope: 'system', channelId: ch.id, profileId: null, name: 'engineered-probe' },
    embed: ledgeredEmbedder(db, ch.id, usdInrRate),
    judge: (lint, text) => judgeLint(lint, text, { db, apiKey: llmKey, usdInrRate, subject: { kind: 'channel', channelId: ch.id, idempotencyKey: `judge:probe:${randomUUID()}`, stage: '20-judge' } }),
  });
  console.log('CREATE:', JSON.stringify(r));
  if (!r.ok) process.exit(1);
  const { data: row } = await db.from('briefs').select('*').eq('id', r.brief_id).single();
  console.log(`\nBRIEF ${row.id} — ${row.status}\nPREMISE: ${row.premise}\nHERO OBJECTS: ${JSON.stringify(row.hero_objects)}\nFACT: ${JSON.stringify(row.fact)}\nTITLES: ${JSON.stringify(row.titles)}\nENDINGS: ${JSON.stringify(row.punchlines)}\nPOLICY: ${row.policy?.status} ${JSON.stringify(row.policy?.violations ?? [])}\nVARIATION: ${row.variation?.status}${row.variation?.refused_reason ? ` (${row.variation.refused_reason})` : ''}\nESTIMATE (series default): ₹${row.estimate_inr}\nFLAG: ${row.flagged} ${JSON.stringify(row.flag_reasons)}\n`);
  for (const [i, s] of row.shot_list.entries()) console.log(`${String(i + 1).padStart(2)}. [${s.view}${s.action ? ', action' : ''}] ${row.script_text.split('\n')[i]}\n      picture: ${s.description}\n      graphics: ${JSON.stringify(s.graphics ?? {})}`);
  const { data: cost } = await db.from('cost_ledger').select('stage, cost_inr').eq('channel_id', ch.id);
  console.log(`\nLEDGER on the channel so far: ${JSON.stringify(cost)}`);
  process.exit(0);
}

// ── --proof ──────────────────────────────────────────────────────────────────
const { data: brief } = await db.from('briefs').select('*').eq('channel_id', ch.id).eq('status', 'pending').order('created_at', { ascending: false }).limit(1).maybeSingle();
if (!brief) {
  console.error('No pending Built Like That brief — run --brief first.');
  process.exit(1);
}
const objects = heroObjectsOf(brief.hero_objects);
const hero = objects[0];
const beatIdx = brief.shot_list.findIndex((s) => s.view === 'scene' && (s.objects ?? []).includes(hero?.tag));
if (!hero || beatIdx < 0) {
  console.error('The brief has no hero object shown in a scene beat.');
  process.exit(1);
}
const priced = 2 * imageInr;
console.log(`Proof for brief ${brief.id.slice(0, 8)}: @${hero.tag} (${hero.name}), beat ${beatIdx + 1}; two images ≈ ₹${priced.toFixed(2)} (limit ₹${maxInr})`);
if (!rate.is_verified || priced > maxInr) {
  console.error('Refusing: the image rate is unverified or the proof is priced over --max-inr.');
  process.exit(1);
}
const look = engineeredLook(cb.bible.world);
const requestId = randomUUID();
await db.from('authorship_log').insert({ channel_id: ch.id, actor_scope: 'system', action: 'engineered_probe', subject_type: 'brief', subject_id: brief.id, exact_text: null, payload: { request_id: requestId, via: 'engineered-probe workflow (one object sheet, one 3D picture, four frames)' } });
const deps = {
  usdInrRate,
  apiKey: () => verifiedCredential(db, STILL_INTEGRATION, STILL_CREDENTIAL_FIELD),
  submit: (i) => submitStill(i),
  wait: (i) => waitStill(i),
  fetchBytes: async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  },
  putBytes,
  log: console,
};
const sp = objectSheetPrompt(hero, look, undefined, STILL_PROMPT_MAX);
if (!sp.ok) {
  console.error(sp.reason);
  process.exit(1);
}
console.log(`\nSHEET PROMPT (${OBJECT_SHEET_PROMPT_REF}):\n${sp.prompt}\n`);
const sheet = await makeSheetImage(db, {
  key: `objsheet-probe:${brief.id}:${hero.tag}:${requestId}`,
  channelId: ch.id,
  prompt: sp.prompt,
  payload: { purpose: 'object_sheet', channel_id: ch.id, brief_id: brief.id, object: hero.tag, name: hero.name, probe: true, prompt: sp.prompt, prompt_ref: OBJECT_SHEET_PROMPT_REF, ratio: STILL_RATIO },
  stage: '05-object-sheet',
  storageKeyFor: (g, ext) => `objects/probe-${brief.id.slice(0, 8)}/${hero.tag}-${g.slice(0, 8)}.${ext}`,
  assetMeta: { purpose: 'object_sheet', brief_id: brief.id, object: hero.tag, prompt_ref: OBJECT_SHEET_PROMPT_REF, probe: true },
  noun: 'object sheet',
}, deps);
console.log('SHEET:', JSON.stringify(sheet));
if (!sheet.ok) process.exit(1);

const beat = brief.shot_list[beatIdx];
const narration = brief.script_text.split('\n')[beatIdx]?.replace(/^[^:]+:\s*/, '');
const engineered = { look, view: beat.view, action: !!beat.action, objects: [{ tag: hero.tag, name: hero.name, ref: `storage:${sheet.storageKey}` }], known: objects.map((o) => ({ tag: o.tag, name: o.name })) };
const pp = await stillPromptFor(
  { description: beat.description, premise: brief.premise, cast: cb.bible.characters.map((c) => ({ id: c.id, name: c.name })), world: cb.bible.world, accent: '#FFD23F', narration, engineered },
  { db, apiKey: llmKey, usdInrRate, subject: { kind: 'channel', channelId: ch.id, idempotencyKey: `probe-still:${requestId}:prompt`, stage: '20-still-prompt' } },
);
if (!pp.ok) {
  console.error(`No picture prompt: ${pp.reason}`);
  process.exit(1);
}
console.log(`\nPICTURE PROMPT (${pp.promptRef}, rewrite ${pp.model}):\n${pp.prompt}\n`);
const pic = await makeSheetImage(db, {
  key: `still-probe:${brief.id}:${beatIdx}:${requestId}`,
  channelId: ch.id,
  prompt: pp.prompt,
  payload: { purpose: 'engineered_probe_still', channel_id: ch.id, brief_id: brief.id, beat: beatIdx, objects: [{ tag: hero.tag, ref: `storage:${sheet.storageKey}` }], prompt: pp.prompt, prompt_ref: pp.promptRef, ratio: STILL_RATIO },
  stage: '05-still',
  storageKeyFor: (g, ext) => `stills/probe-${brief.id.slice(0, 8)}/beat-${beatIdx}-${g.slice(0, 8)}.${ext}`,
  assetMeta: { purpose: 'engineered_probe_still', brief_id: brief.id, beat: beatIdx, prompt_ref: pp.promptRef, probe: true },
  noun: '3D picture',
  references: [{ uri: await presign(sheet.storageKey), tag: hero.tag }],
}, deps);
console.log('PICTURE:', JSON.stringify(pic));
if (!pic.ok) process.exit(1);

const { data: ledger } = await db.from('cost_ledger').select('stage, entry_kind, cost_source, unit, quantity, cost_inr, idempotency_key').in('generation_id', [sheet.generationId, pic.generationId]);
console.log('LEDGER:', JSON.stringify(ledger));
await mkdir('out/engineered-probe', { recursive: true });
const save = async (key, name) => {
  const res = await fetch(await presign(key));
  const file = `out/engineered-probe/${name}`;
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
};
const sheetFile = await save(sheet.storageKey, `sheet-${hero.tag}.png`);
const picFile = await save(pic.storageKey, `picture-beat-${beatIdx + 1}.png`);
await run('node', ['scripts/engineered-frame.mjs', 'out/engineered-probe/frames', picFile]);
await run('ffmpeg', ['-v', 'error', '-y', ...['1-badge', '2-verdict', '3-callouts', '4-meter'].flatMap((n) => ['-i', `out/engineered-probe/frames/${n}.png`]), '-filter_complex', '[0]scale=270:480[a];[1]scale=270:480[b];[2]scale=270:480[c];[3]scale=270:480[d];[a][b][c][d]hstack=4', 'out/engineered-probe/frames-grid.png']);
await printJpeg('SHEET', sheetFile, 216, 384);
await printJpeg('PICTURE', picFile, 216, 384);
await printJpeg('FRAMES', 'out/engineered-probe/frames-grid.png', 720, 320);
console.log('\nDone: one object sheet, one 3D picture drawn from it, four graphics frames over it.');
