/**
 * Re-label every stored object with the Content-Type its key names (08-Oct-2026).
 *
 * Until `contentTypeFor` (src/lib/storage/content-type.ts) every upload went up as video/mp4,
 * so the bucket serves sheets, stills and voice lines with a video type. Runway checks the type
 * of a reference image and refused every picture of the first 3D explainer for it. This copies
 * each mislabelled object onto itself with the right type (S3 CopyObject, MetadataDirective
 * REPLACE) — the bytes do not move through here and nothing is regenerated or paid for.
 *
 *   node scripts/storage-retype.mjs            # dry run: counts what would change
 *   node scripts/storage-retype.mjs --apply    # does it
 *
 * Reads SUPABASE_S3_* and SUPABASE_STORAGE_BUCKET from the environment (the workflow fills them
 * from Vercel production). Exits 1 if any copy failed, naming it.
 */
import { CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const apply = process.argv.includes('--apply');
const need = ['SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY', 'SUPABASE_STORAGE_BUCKET', 'SUPABASE_S3_ENDPOINT'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}`);
  process.exit(2);
}
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', json: 'application/json', srt: 'application/x-subrip', vtt: 'text/vtt', txt: 'text/plain' };
const typeFor = (key) => TYPES[/\.([a-z0-9]+)$/i.exec(key)?.[1]?.toLowerCase() ?? ''] ?? null;

const Bucket = process.env.SUPABASE_STORAGE_BUCKET;
const s3 = new S3Client({
  region: process.env.SUPABASE_S3_REGION || 'us-east-1',
  endpoint: process.env.SUPABASE_S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.SUPABASE_S3_ACCESS_KEY_ID, secretAccessKey: process.env.SUPABASE_S3_SECRET_ACCESS_KEY },
});

const counts = { listed: 0, right: 0, unknownExt: 0, wrong: 0, fixed: 0, failed: 0 };
const byWrong = {};
const failures = [];
let ContinuationToken;
do {
  const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken, MaxKeys: 1000 }));
  for (const o of page.Contents ?? []) {
    counts.listed++;
    const want = typeFor(o.Key);
    if (!want) { counts.unknownExt++; continue; }
    const head = await s3.send(new HeadObjectCommand({ Bucket, Key: o.Key }));
    if (head.ContentType === want) { counts.right++; continue; }
    counts.wrong++;
    const k = `${head.ContentType} → ${want}`;
    byWrong[k] = (byWrong[k] ?? 0) + 1;
    if (!apply) continue;
    try {
      await s3.send(new CopyObjectCommand({ Bucket, Key: o.Key, CopySource: `${Bucket}/${encodeURIComponent(o.Key).replace(/%2F/g, '/')}`, MetadataDirective: 'REPLACE', ContentType: want }));
      const after = await s3.send(new HeadObjectCommand({ Bucket, Key: o.Key }));
      if (after.ContentType === want) counts.fixed++;
      else { counts.failed++; failures.push(`${o.Key}: still ${after.ContentType}`); }
    } catch (err) {
      counts.failed++;
      failures.push(`${o.Key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (ContinuationToken);

console.log(`${apply ? 'APPLIED' : 'DRY RUN'}: ${JSON.stringify(counts)}`);
console.log(`mislabelled: ${JSON.stringify(byWrong)}`);
for (const f of failures.slice(0, 20)) console.log(`FAILED ${f}`);
process.exit(counts.failed ? 1 : 0);
