#!/usr/bin/env node
/**
 * pnpm probe:sheet <character slug> — make ONE character sheet through the production path
 * (decision 0024), against the real vendor, the real ledger and the real bucket. It does NOT
 * lock it: Sahil looks at it on Library → Characters and locks it himself.
 *
 * `--via worker` (the default) triggers the deployed `27-character-sheet` task with the same
 * payload the "Generate sheet" button sends, and waits for its run — the worker's code, the
 * worker's environment. `--via function` calls `generateCharacterSheet` here with the same deps
 * shape, for when the task cannot be triggered (no Trigger.dev secret in Vercel's production
 * environment); the rows written are identical.
 *
 * Rules 5 and 6 hold as in production: the generation and the ₹ estimate are written before the
 * call, keyed sheet:<channel>:<slug>:<request>. `--max-inr` (default 5) refuses anything priced
 * above it before a rupee moves. The request is logged to authorship_log as a system action
 * naming this probe, so the spend has an author.
 *
 * Output: the prompt, the ledger rows, the stored key, and the image downscaled to 270×480 as
 * base64 between markers (and the full PNG in ./out/sheet-probe/, uploaded as a run artifact).
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_S3_*, and TRIGGER_SECRET_KEY
 * (worker) or RUNWAY_API_KEY (function).
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
const { generateCharacterSheet, sheetPromptFor } = require(`${B}/bureau/character-sheets.js`);
const { getBible } = require(`${B}/bureau/bible.js`);
const { verifiedCredential } = require(`${B}/integrations/verify.js`);
const { submitStill, waitStill, STILL_INTEGRATION, STILL_CREDENTIAL_FIELD, STILL_RATE_KEY } = require(`${B}/drivers/still-image.js`);
const { createSupabaseStorageDriver } = require(`${B}/storage/supabase.js`);
const { createClient } = await import('@supabase/supabase-js');

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const slug = process.argv[2];
const maxInr = Number(arg('--max-inr', '5'));
const via = arg('--via', 'worker');
const channelSlug = arg('--channel', 'bureau-of-reality');
if (!slug || slug.startsWith('--') || !['worker', 'function'].includes(via)) {
  console.error('usage: pnpm probe:sheet <character slug> [--via worker|function] [--max-inr 5] [--channel bureau-of-reality]');
  process.exit(2);
}
const need = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY', ...(via === 'worker' ? ['TRIGGER_SECRET_KEY'] : [])];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}${via === 'worker' ? ' (or run with --via function)' : ''}`);
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

const { data: ch } = await db.from('channels').select('id, name').eq('slug', channelSlug).single();
if (!ch) {
  console.error(`No channel ${channelSlug}`);
  process.exit(2);
}
const cb = await getBible(db, ch.id);
const c = cb.characterBySlug(slug);
if (!c) {
  console.error(`No character "${slug}" in ${channelSlug}. Known: ${cb.bible.characters.map((x) => x.id).join(', ')}`);
  process.exit(2);
}
const { data: fx } = await db.from('profiles').select('usd_inr_rate').not('usd_inr_rate', 'is', null).limit(1).single();
const usdInrRate = Number(fx.usd_inr_rate);
const { data: rate } = await db.from('rate_card').select('unit_cost, is_verified').eq('driver', STILL_RATE_KEY.driver).eq('model', STILL_RATE_KEY.model).eq('unit', STILL_RATE_KEY.unit).single();
const priced = Number(rate.unit_cost) * usdInrRate;
const p = sheetPromptFor(cb, c.id, null);
console.log(`${c.name} (${c.id}) on ${ch.name}; bible from ${cb.source}; one sheet ≈ ₹${priced.toFixed(2)} (limit ₹${maxInr}); via ${via}`);
console.log(`locked now: ${JSON.stringify(c.reference_frame_ids)}`);
if (!p.ok) {
  console.error(`No prompt: ${p.reason}`);
  process.exit(1);
}
console.log(`\nPROMPT (built from the bible):\n${p.prompt}\n`);
if (!rate.is_verified || priced > maxInr) {
  console.error('Refusing: the rate is unverified or the sheet is priced over --max-inr.');
  process.exit(1);
}

const requestId = randomUUID();
await db.from('authorship_log').insert({ channel_id: ch.id, actor_scope: 'system', action: 'character_sheet_request', subject_type: 'character', subject_id: c.id, exact_text: null, payload: { request_id: requestId, via: 'sheet-probe workflow (one real check, not locked)' } });

let result;
if (via === 'worker') {
  const { configure, tasks, runs } = await import('@trigger.dev/sdk');
  configure({ secretKey: process.env.TRIGGER_SECRET_KEY });
  const handle = await tasks.trigger('27-character-sheet', { channelId: ch.id, slug: c.id, note: null, requestId }, { idempotencyKey: `sheet:${requestId}` });
  console.log(`triggered 27-character-sheet: run ${handle.id}`);
  const done = await runs.poll(handle, { pollIntervalMs: 5000 });
  console.log(`run ${done.id}: ${done.status}`);
  result = done.output ?? { ok: false, reason: `run ended ${done.status}${done.error ? `: ${JSON.stringify(done.error).slice(0, 400)}` : ''}` };
} else {
  result = await generateCharacterSheet(
    db,
    { channelId: ch.id, slug: c.id, note: null, requestId },
    {
      usdInrRate,
      apiKey: () => verifiedCredential(db, STILL_INTEGRATION, STILL_CREDENTIAL_FIELD),
      submit: (i) => submitStill(i),
      wait: (i) => waitStill(i),
      fetchBytes: async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      },
      putBytes: async (key, body) => {
        const chunks = [];
        for await (const x of body) chunks.push(Buffer.from(x));
        const bytes = Buffer.concat(chunks);
        const signed = await driver.presignPut({ key, contentType: 'image/png' });
        const res = await fetch(signed.url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': 'image/png' } });
        if (!res.ok) throw new Error(`PUT ${key}: HTTP ${res.status}`);
        return bytes.length;
      },
      log: console,
    },
  );
}
if (!result?.ok) {
  console.error(`No sheet: ${result?.reason} (money spent: ${result?.spent})`);
  process.exit(1);
}
const { data: rows } = await db.from('cost_ledger').select('entry_kind, cost_source, unit, quantity, cost_inr, stage, idempotency_key').eq('generation_id', result.generationId);
console.log('LEDGER:', JSON.stringify(rows));
console.log(`STORED: ${result.storageKey} (generation ${result.generationId}) — NOT locked`);
const { data: after } = await db.from('channel_characters').select('reference_frame').eq('channel_id', ch.id).eq('slug', c.id).maybeSingle();
console.log(`reference_frame after: ${JSON.stringify(after?.reference_frame ?? null)}`);

const got = await fetch((await driver.presignGet({ key: result.storageKey, expiresIn: 600 })).url);
const raw = Buffer.from(await got.arrayBuffer());
await mkdir('out/sheet-probe', { recursive: true });
const full = `out/sheet-probe/${c.id}-${result.generationId.slice(0, 8)}.png`;
await writeFile(full, raw);
await run('ffmpeg', ['-v', 'error', '-y', '-i', full, '-vf', 'scale=270:480', '-q:v', '4', '/tmp/sheet-small.jpg']);
const small = (await readFile('/tmp/sheet-small.jpg')).toString('base64');
console.log(`READ BACK: ${raw.length} bytes from the bucket → ${full}\n----- BEGIN SHEET JPEG BASE64 -----`);
for (let i = 0; i < small.length; i += 120) console.log(small.slice(i, i + 120));
console.log('----- END SHEET JPEG BASE64 -----');
