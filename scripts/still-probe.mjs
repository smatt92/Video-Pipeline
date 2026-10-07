#!/usr/bin/env node
/**
 * pnpm probe:still <shot id> — make ONE scene still for one existing shot, through the
 * production function (`generateStillForShot`, decision 0021), against the real vendor, the
 * real ledger and the real bucket. This is the one real check 0008 records; it is not part of
 * any pipeline and nothing calls it on a schedule.
 *
 * Why a script and not the worker: the hosted database and the vendor are unreachable from the
 * development container (0008), and a Trigger task needs a caller. The "Still probe" GitHub
 * Action runs this on a runner that can reach both, with the production environment read from
 * Vercel exactly as the worker's deploy reads it (0017). Same function, same deps shape as
 * `20-episode` passes, same rows written.
 *
 * Rule 5 and 6 hold as in production: the generation row and the ₹ estimate are written before
 * the call, keyed still:<shot>:<attempt>. The cap is read first. `--max-inr` (default 5) refuses
 * anything priced above it before a rupee moves.
 *
 * Output: the prompt that was sent, the ledger rows, and the stored image downscaled to a
 * 270×480 JPEG printed as base64 between markers — the only way a person reading the job log
 * can look at it.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_S3_*, RUNWAY_API_KEY,
 * ANTHROPIC_API_KEY (the integrations must have verified — the same predicate as production).
 */
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { generateStillForShot } = require(`${B}/bureau/stills.js`);
const { getBible } = require(`${B}/bureau/bible.js`);
const { verifiedCredential } = require(`${B}/integrations/verify.js`);
const { submitStill, waitStill, STILL_INTEGRATION, STILL_CREDENTIAL_FIELD } = require(`${B}/drivers/still-image.js`);
const { createSupabaseStorageDriver } = require(`${B}/storage/supabase.js`);
const { createClient } = await import('@supabase/supabase-js');

const shotId = process.argv[2];
const maxInr = Number(process.argv.includes('--max-inr') ? process.argv[process.argv.indexOf('--max-inr') + 1] : 5);
if (!/^[0-9a-f-]{36}$/.test(shotId ?? '')) {
  console.error('usage: pnpm probe:still <shot uuid> [--max-inr 5]');
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

const { data: shot, error } = await db.from('shots').select('id, idx, description, script_id').eq('id', shotId).single();
if (error || !shot) {
  console.error(`No shot ${shotId}: ${error?.message}`);
  process.exit(2);
}
const { data: ep } = await db.from('episodes').select('id, channel_id, brief_id, kind').eq('script_id', shot.script_id).single();
const { data: brief } = await db.from('briefs').select('premise, lead_character').eq('id', ep.brief_id).single();
const { data: fx } = await db.from('profiles').select('usd_inr_rate').not('usd_inr_rate', 'is', null).limit(1).single();
const usdInrRate = Number(fx.usd_inr_rate);
const cb = await getBible(db, ep.channel_id);
const lead = cb.characterBySlug(brief.lead_character);
const { data: rate } = await db.from('rate_card').select('unit_cost, is_verified').eq('driver', 'runway').eq('model', 'gen4_image').eq('unit', 'image_720p').single();
const priced = Number(rate.unit_cost) * usdInrRate;
console.log(`shot ${shot.idx}: "${shot.description}"\nbible from ${cb.source}; lead ${lead.name} ${lead.accent_hex}; one still ≈ ₹${priced.toFixed(2)} (limit ₹${maxInr})`);
if (!rate.is_verified || priced > maxInr) {
  console.error('Refusing: the rate is unverified or the still is priced over --max-inr.');
  process.exit(1);
}
const anthropic = await verifiedCredential(db, 'anthropic', 'ANTHROPIC_API_KEY');

const r = await generateStillForShot(
  db,
  { shot, channelId: ep.channel_id, premise: brief.premise, cast: cb.bible.characters.map((c) => ({ id: c.id, name: c.name })), world: cb.bible.world, accent: lead.accent_hex, kind: ep.kind === 'long_form' ? 'long_form' : 'short' },
  {
    usdInrRate,
    llmKey: anthropic.ok ? anthropic.value : null,
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
      for await (const c of body) chunks.push(Buffer.from(c));
      const bytes = Buffer.concat(chunks);
      const signed = await driver.presignPut({ key, contentType: 'image/png' });
      const res = await fetch(signed.url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': 'image/png' } });
      if (!res.ok) throw new Error(`PUT ${key}: HTTP ${res.status}`);
      return bytes.length;
    },
    log: console,
  },
);
if (!r.ok) {
  console.error(`No still: ${r.reason} (money spent: ${r.spent})`);
  process.exit(1);
}
console.log(`\nPROMPT SENT:\n${r.prompt}\n`);
const { data: rows } = await db.from('cost_ledger').select('entry_kind, cost_source, unit, quantity, cost_inr, stage, idempotency_key').eq('generation_id', r.generationId);
console.log('LEDGER:', JSON.stringify(rows));
console.log(`STORED: ${r.storageKey} (asset ${r.assetId}, generation ${r.generationId})`);

const got = await fetch((await driver.presignGet({ key: r.storageKey, expiresIn: 600 })).url);
const raw = Buffer.from(await got.arrayBuffer());
await writeFile('/tmp/still-full', raw);
await run('ffmpeg', ['-v', 'error', '-y', '-i', '/tmp/still-full', '-vf', 'scale=270:480', '-q:v', '4', '/tmp/still-small.jpg']);
const small = (await readFile('/tmp/still-small.jpg')).toString('base64');
console.log(`READ BACK: ${raw.length} bytes from the bucket\n----- BEGIN STILL JPEG BASE64 -----`);
for (let i = 0; i < small.length; i += 120) console.log(small.slice(i, i + 120));
console.log('----- END STILL JPEG BASE64 -----');
