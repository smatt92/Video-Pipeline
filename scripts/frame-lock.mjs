#!/usr/bin/env node
/**
 * pnpm frame:lock <character> <file> [--append] — make Sahil's pick the character's locked frame.
 *
 * The only writer of a `storage:` reference in characters.json. Uploads the chosen image to
 * the bucket under a content-addressed key (characters/<id>/ref-<sha>.png), reads it back
 * and compares bytes, then replaces the character's `reference_frame_ids` with that one
 * reference (or appends it with --append; the vendor takes at most three). Leaves the commit
 * to you: the bible is source-controlled, and a locked look is an editorial decision with an
 * author. `syncCast` copies it to `characters.external_ref_id` on the next episode run.
 *
 *   SUPABASE_S3_ACCESS_KEY_ID=... SUPABASE_S3_SECRET_ACCESS_KEY=... NEXT_PUBLIC_SUPABASE_URL=... \
 *     pnpm frame:lock pip out/frames/pip/ab12cd34-2.png
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname } from 'node:path';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { frameKey, frameRef } = require(`${B}/bureau/frames.js`);
const { createSupabaseStorageDriver } = require(`${B}/storage/supabase.js`);

const pos = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--channel');
const append = process.argv.includes('--append');
const [character, file] = pos;
if (!character || !file) {
  console.error('usage: pnpm frame:lock <character> <file> [--append]');
  process.exit(2);
}
const ext = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg' }[extname(file).toLowerCase()];
if (!ext) {
  console.error(`${file}: only png or jpg frames are locked (what the generator is fed).`);
  process.exit(2);
}
const bytes = readFileSync(file);
if (bytes.length > 5 * 1024 * 1024) {
  console.error(`${file} is ${(bytes.length / 1048576).toFixed(1)} MB; the vendor's image input limit is 5 MB.`);
  process.exit(2);
}

// --channel <slug>; the Bureau when omitted.
const CHANNEL_SLUG = process.argv.includes('--channel') ? process.argv[process.argv.indexOf('--channel') + 1] : 'bureau-of-reality';
const path = new URL(`../channels/${CHANNEL_SLUG}/characters.json`, import.meta.url).pathname;
const text = readFileSync(path, 'utf8');
const data = JSON.parse(text);
const c = data.characters.find((x) => x.id === character);
if (!c) {
  console.error(`No character "${character}". Known: ${data.characters.map((x) => x.id).join(', ')}`);
  process.exit(2);
}

const id = process.env.SUPABASE_S3_ACCESS_KEY_ID;
const secret = process.env.SUPABASE_S3_SECRET_ACCESS_KEY;
const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!id || !secret || (!process.env.SUPABASE_S3_ENDPOINT && !base)) {
  console.error('SUPABASE_S3_ACCESS_KEY_ID, SUPABASE_S3_SECRET_ACCESS_KEY and NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_S3_ENDPOINT) are required to upload the frame.');
  process.exit(2);
}
const driver = createSupabaseStorageDriver({
  accessKeyId: id,
  secretAccessKey: secret,
  bucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'kiln-media',
  region: process.env.SUPABASE_S3_REGION ?? 'us-east-1',
  endpoint: process.env.SUPABASE_S3_ENDPOINT ?? `${base.replace(/\/$/, '')}/storage/v1/s3`,
});

const sha = createHash('sha256').update(bytes).digest('hex');
const key = frameKey(c.id, sha, ext);
const contentType = ext === 'png' ? 'image/png' : 'image/jpeg';
const put = await driver.presignPut({ key, contentType, contentLength: bytes.length });
const up = await fetch(put.url, { method: 'PUT', body: new Uint8Array(bytes), headers: { 'content-type': contentType } });
if (!up.ok) {
  console.error(`Upload failed: HTTP ${up.status} ${await up.text()}`);
  process.exit(1);
}
// Read it back before the bible points at it: a reference that does not resolve would turn
// every character beat for this character into a refused job.
const back = await fetch((await driver.presignGet({ key, expiresIn: 300 })).url);
const backBytes = back.ok ? Buffer.from(await back.arrayBuffer()) : null;
if (!backBytes || createHash('sha256').update(backBytes).digest('hex') !== sha) {
  console.error(`Read-back of ${key} did not return the bytes uploaded (HTTP ${back.status}). characters.json not changed.`);
  process.exit(1);
}

const ref = frameRef(key);
const kept = append ? c.reference_frame_ids.filter((r) => !r.startsWith('PLACEHOLDER_') && r !== ref) : [];
const next = [...kept, ref];
if (next.length > 3) {
  console.error(`${c.name} would have ${next.length} reference frames; the vendor takes at most three. Lock without --append to replace.`);
  process.exit(1);
}
// Replace this character's reference_frame_ids line only, formatting preserved.
const start = text.indexOf(`"id": "${character}"`);
const end = text.indexOf('"never_do"', start);
const block = text.slice(start, end);
const replaced = block.replace(/"reference_frame_ids": \[[^\]]*\]/, `"reference_frame_ids": ${JSON.stringify(next).replace(/","/g, '", "')}`);
if (replaced === block) {
  console.error(`${character}'s reference_frame_ids line is not in the expected shape; edit it by hand to: ${JSON.stringify(next)}`);
  process.exit(1);
}
writeFileSync(path, text.slice(0, start) + replaced + text.slice(end));
JSON.parse(readFileSync(path, 'utf8'));
console.log(`Locked ${c.name} → ${ref}\nCommit channels/${CHANNEL_SLUG}/characters.json to make it live (syncCast copies it on the next episode run).`);
