#!/usr/bin/env node
/**
 * pnpm frame:audition — produce candidate reference frames for one character, then pick.
 *
 * Renders --count images with Runway text-to-image (gen4_image by default) from the
 * character's visual lock in characters.json plus up to three reference images, into
 * ./out/frames/<character>/<n>.png. Writes NOTHING to storage or characters.json — Sahil
 * looks, then runs `pnpm frame:lock <character> <file>`. Same pattern as voice:audition.
 *
 * Reference images, in order of preference:
 *   --ref <file|https url>   up to three; files are sent inline (≤ 5 MB each, the vendor cap)
 *   (none given)             the character's currently locked frames, to RE-produce a look —
 *                            storage refs need SUPABASE_S3_* and NEXT_PUBLIC_SUPABASE_URL
 *   (neither)                text only (gen4_image allows it; gen4_image_turbo does not)
 *
 * Money: priced up front from the verified rate_card row for (runway, model, /v1/text_to_image,
 * image_720p|image_1080p|image) and refused if over --max-usd (default 0.50). Each render
 * writes a cost_ledger estimate BEFORE the call, and a measured reconcile after it when the
 * vendor's terminal task says what it charged — rule 5 has no exception for auditions.
 *
 *   RUNWAY_API_KEY=... DATABASE_URL=... pnpm frame:audition --character pip \
 *     [--ref ./sheet.png --ref https://…] [--count 4] [--model gen4_image|gen4_image_turbo] \
 *     [--ratio 720:1280|1080:1920] [--prompt "pose override"] [--max-usd 0.50] [--seed 7]
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { submitImage, imageCredits, imageRateUnit, IMAGE_MODELS, PROMPT_MAX } = require(`${B}/drivers/video-runway.js`);
const { waitForTask, CREDIT_USD } = require(`${B}/drivers/runway.js`);
const { bibleForSlug, STORAGE_REF_PREFIX } = require(`${B}/bureau/bible.js`);
// --channel <slug>: whose cast, and whose ledger the spend lands on. The Bureau when omitted —
// it is the channel these tools were written for; any other channel names itself.
const CHANNEL_SLUG = process.argv.includes('--channel') ? process.argv[process.argv.indexOf('--channel') + 1] : 'bureau-of-reality';
const BIBLE = bibleForSlug(CHANNEL_SLUG).bible;
const { framePrompt } = require(`${B}/bureau/frames.js`);

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : dflt;
};
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));

const characterId = arg('character');
const c = BIBLE.characters.find((x) => x.id === characterId);
if (!c) {
  console.error(`usage: pnpm frame:audition --character <${BIBLE.characters.map((x) => x.id).join('|')}> [options]`);
  process.exit(2);
}
const model = arg('model', 'gen4_image');
if (!IMAGE_MODELS[model]) {
  console.error(`--model must be one of ${Object.keys(IMAGE_MODELS).join(', ')}`);
  process.exit(2);
}
const ratio = arg('ratio', '720:1280');
if (!['720:1280', '1080:1920'].includes(ratio)) {
  console.error('--ratio must be 720:1280 or 1080:1920 (9:16 frames; gen4_turbo animates at 720:1280)');
  process.exit(2);
}
const count = Number(arg('count', '4'));
const maxUsd = Number(arg('max-usd', '0.50'));
const seed = arg('seed') === undefined ? undefined : Number(arg('seed'));
if (!Number.isInteger(count) || count < 1 || count > 8) {
  console.error('--count must be 1–8');
  process.exit(2);
}

const apiKey = process.env.RUNWAY_API_KEY;
const dbUrl = process.env.DATABASE_URL;
if (!apiKey || !dbUrl) {
  console.error('RUNWAY_API_KEY and DATABASE_URL are both required (the second for the cost rows).');
  process.exit(2);
}

// ── References ──────────────────────────────────────────────────────────────
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
async function asUri(ref) {
  if (/^https:\/\//.test(ref)) return ref;
  if (ref.startsWith(STORAGE_REF_PREFIX)) return presignStored(ref.slice(STORAGE_REF_PREFIX.length));
  const mime = MIME[extname(ref).toLowerCase()];
  if (!mime) throw new Error(`${ref}: not a png/jpg/webp file or an https URL`);
  const size = (await stat(ref)).size;
  if (size > 5 * 1024 * 1024) throw new Error(`${ref} is ${(size / 1048576).toFixed(1)} MB; the vendor's inline limit is 5 MB`);
  return `data:${mime};base64,${(await readFile(ref)).toString('base64')}`;
}
async function presignStored(key) {
  const { createSupabaseStorageDriver } = require(`${B}/storage/supabase.js`);
  const id = process.env.SUPABASE_S3_ACCESS_KEY_ID;
  const secret = process.env.SUPABASE_S3_SECRET_ACCESS_KEY;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!id || !secret || (!process.env.SUPABASE_S3_ENDPOINT && !base)) {
    throw new Error('re-producing from a locked frame needs SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY and NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_S3_ENDPOINT); or pass --ref');
  }
  const driver = createSupabaseStorageDriver({
    accessKeyId: id,
    secretAccessKey: secret,
    bucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'kiln-media',
    region: process.env.SUPABASE_S3_REGION ?? 'us-east-1',
    endpoint: process.env.SUPABASE_S3_ENDPOINT ?? `${base.replace(/\/$/, '')}/storage/v1/s3`,
  });
  return (await driver.presignGet({ key, expiresIn: 15 * 60 })).url;
}

const given = all('ref');
const locked = c.reference_frame_ids.filter((r) => !r.startsWith('PLACEHOLDER_'));
const refSource = given.length ? given : locked;
if (refSource.length > 3) {
  console.error(`At most three reference images (got ${refSource.length}).`);
  process.exit(2);
}
const references = [];
for (const [i, r] of refSource.entries()) references.push({ uri: await asUri(r), tag: `${c.id.replace(/[^a-z0-9_]/g, '')}_ref${i + 1}`.slice(0, 16) });

let prompt = framePrompt(c, BIBLE.world, arg('prompt'));
if (references.length) prompt = `Match the character in @${references[0].tag} exactly. ${prompt}`;
if (prompt.length > PROMPT_MAX) {
  console.error(`The frame prompt is ${prompt.length} characters; the vendor's limit is ${PROMPT_MAX}. Shorten --prompt or the visual_lock.`);
  process.exit(1);
}

// ── Price, before anything is spent ─────────────────────────────────────────
const pg = (await import('pg')).default;
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const chRow = (await client.query('select id from channels where slug = $1', [CHANNEL_SLUG])).rows[0];
if (!chRow) {
  console.error(`No channel row with slug ${CHANNEL_SLUG} — add the channel in Kiln first.`);
  process.exit(2);
}
const CHANNEL_ID = chRow.id;
const unit = model === 'gen4_image_turbo' ? 'image' : imageRateUnit(ratio);
const { rows: rate } = await client.query(
  `select unit_cost, is_verified from rate_card where driver = 'runway' and model = $1 and endpoint = '/v1/text_to_image' and unit = $2 and effective_from <= now() order by effective_from desc limit 1`,
  [model, unit],
);
if (!rate[0]?.is_verified) {
  console.error(`No verified rate for runway/${model} per ${unit} — migration 0044 seeds it. Nothing prices against a guess.`);
  process.exit(1);
}
const unitUsd = Number(rate[0].unit_cost);
if (Math.abs(unitUsd - imageCredits(model, ratio) * CREDIT_USD) > 1e-9) {
  console.error(`rate_card says $${unitUsd} per ${unit} but the driver's table says ${imageCredits(model, ratio)} credits — reconcile them before spending.`);
  process.exit(1);
}
const { rows: fx } = await client.query('select usd_inr_rate from profiles where usd_inr_rate is not null limit 1');
const fxRate = fx[0] ? Number(fx[0].usd_inr_rate) : null;
if (fxRate === null) {
  console.error('No USD→INR rate in profiles; the cost rows cannot be priced. Set it in Settings → Workspace.');
  process.exit(1);
}
const usd = count * unitUsd;
console.log(`\n${c.name}: ${count} × ${model} at ${ratio}, ${references.length} reference image(s), ~$${usd.toFixed(2)} (limit $${maxUsd.toFixed(2)})\n`);
if (usd > maxUsd) {
  console.error(`Refusing: ~$${usd.toFixed(2)} is over --max-usd ${maxUsd}. Lower --count or raise the limit.`);
  process.exit(1);
}

// ── Render ──────────────────────────────────────────────────────────────────
const dir = join('out', 'frames', c.id);
await mkdir(dir, { recursive: true });
const run = randomUUID().slice(0, 8);
for (let n = 1; n <= count; n++) {
  const key = `frame-audition:${c.id}:${run}:${n}`;
  await client.query(
    `insert into cost_ledger (channel_id, driver, stage, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate, idempotency_key, cost_source)
     values ($1, 'runway', 'frame-audition', 'estimate', $2, 1, $3, $4, $5, $6, 'rate_card')`,
    [CHANNEL_ID, unit, unitUsd, unitUsd * fxRate, fxRate, `${key}:estimate`],
  );
  const started = await submitImage({ model, prompt, ratio, references, seed: seed === undefined ? undefined : seed + n - 1 }, { apiKey });
  if (!started.ok) {
    console.error(`  ✗ ${n}: ${started.code} ${started.detail}`);
    continue;
  }
  const done = await waitForTask({ apiKey, taskId: started.taskId, maxWaitMs: 180_000 });
  const charged = done.chargedCredits ?? null;
  if (charged !== null) {
    await client.query(
      `insert into cost_ledger (channel_id, driver, stage, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate, idempotency_key, cost_source)
       values ($1, 'runway', 'frame-audition', 'reconcile', 'credit', $2, $3, $4, $5, $6, 'measured') on conflict do nothing`,
      [CHANNEL_ID, charged, charged * CREDIT_USD, charged * CREDIT_USD * fxRate, fxRate, `${key}:reconcile`],
    );
  }
  if (done.state !== 'succeeded') {
    console.error(`  ✗ ${n}: ${done.state === 'failed' ? `${done.code} ${done.detail}` : 'timeout'}`);
    continue;
  }
  const bytes = Buffer.from(await (await fetch(done.outputUrl)).arrayBuffer());
  const file = join(dir, `${run}-${n}.png`);
  await writeFile(file, bytes);
  console.log(`  ✓ ${file}  sha256:${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}${charged === null ? '' : `  (${charged} credits, measured)`}`);
}
await client.end();
console.log(`\nLook, then: pnpm frame:lock ${c.id} <file>   (writes storage + characters.json; you commit).\n`);
