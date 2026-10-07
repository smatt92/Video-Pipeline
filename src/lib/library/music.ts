import 'server-only';

import { z } from 'zod';

import type { ChannelBible, SeriesId } from '../bureau/bible';
import type { Db } from '../db/server';
import { storageKeySchema } from '../storage/types';
import { isMissingTable, NEEDS_0046 } from './missing';

/**
 * Music beds: which ids a channel's series name, which have audio uploaded, and which one each
 * series uses by default.
 *
 * The bytes never come here (rule 2). The upload is two server actions around a browser PUT:
 * `planBedUpload` validates and builds the key, the action presigns it, the browser PUTs the
 * file straight to the bucket, and `confirmBedUpload` records the row. The key is rebuilt on
 * confirm from (channel, bed, type) — never accepted from the client, because a key that
 * arrives over the wire is an overwrite of somebody else's object waiting to happen.
 *
 * The storage driver has no way to ask "does this object exist" (types.ts: presign, delete,
 * probe), so confirm cannot verify the PUT landed. It records the row and says "unverified"
 * rather than claiming a check it did not make.
 */

export const MUSIC_CONTENT_TYPES = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
} as const;
export type MusicContentType = keyof typeof MUSIC_CONTENT_TYPES;

/** Signed into the PUT as Content-Length, so the cap is the bucket's to enforce, not the browser's. */
export const MUSIC_MAX_BYTES = 25 * 1024 * 1024;

export interface BedRow {
  readonly bedId: string;
  /** The series whose pool names it. */
  readonly series: readonly SeriesId[];
  readonly uploaded: {
    readonly storageKey: string;
    readonly contentType: string;
    /** As declared at upload and signed into the PUT; null when not recorded. */
    readonly bytes: number | null;
    readonly uploadedAt: string;
  } | null;
}

export interface MusicScreen {
  readonly tableMissing: string | null;
  readonly beds: readonly BedRow[];
  /** Every series this channel runs, with its pool and its default (null = none set). */
  readonly series: readonly { readonly id: SeriesId; readonly name: string; readonly pool: readonly string[]; readonly defaultBed: string | null }[];
}

/** Union of music_bed_pool across the channel's series, each bed with the series that name it. */
export function bedPool(cb: ChannelBible): Map<string, SeriesId[]> {
  const out = new Map<string, SeriesId[]>();
  for (const s of Object.values(cb.series)) {
    if (!s) continue;
    for (const bed of s.music_bed_pool) out.set(bed, [...(out.get(bed) ?? []), s.id]);
  }
  return out;
}

export async function musicScreen(db: Db, channelId: string, cb: ChannelBible): Promise<MusicScreen> {
  const pool = bedPool(cb);
  const [beds, defaults] = await Promise.all([
    db.from('music_beds').select('bed_id, storage_key, content_type, bytes, uploaded_at').eq('channel_id', channelId),
    db.from('music_bed_defaults').select('series, bed_id').eq('channel_id', channelId),
  ]);
  const err = beds.error ?? defaults.error;
  if (err && !isMissingTable(err)) throw new Error(`Reading music beds: ${err.message}`);
  const tableMissing = err ? NEEDS_0046 : null;

  const uploaded = new Map((beds.data ?? []).map((b) => [b.bed_id, b]));
  const defaultFor = new Map((defaults.data ?? []).map((d) => [d.series, d.bed_id]));

  return {
    tableMissing,
    beds: [...pool].sort(([a], [b]) => a.localeCompare(b)).map(([bedId, series]) => {
      const u = uploaded.get(bedId);
      return {
        bedId,
        series,
        uploaded: u
          ? {
              storageKey: u.storage_key,
              contentType: u.content_type,
              // bigint: a file size under the 25 MB cap is far inside 2^53, so Number() is safe here.
              bytes: u.bytes === null ? null : Number(u.bytes),
              uploadedAt: u.uploaded_at,
            }
          : null,
      };
    }),
    series: Object.values(cb.series)
      .filter((s): s is NonNullable<typeof s> => !!s)
      .map((s) => ({ id: s.id, name: s.name, pool: s.music_bed_pool, defaultBed: defaultFor.get(s.id) ?? null })),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Upload: plan, then confirm
// ═════════════════════════════════════════════════════════════════════════════

export const BedUploadSchema = z.object({
  bedId: z.string().regex(/^bed_[a-z0-9_]+$/, 'a bed id looks like bed_<name>'),
  contentType: z.enum(Object.keys(MUSIC_CONTENT_TYPES) as [MusicContentType, ...MusicContentType[]], {
    error: `audio only: ${Object.keys(MUSIC_CONTENT_TYPES).join(', ')}`,
  }),
  bytes: z
    .number()
    .int()
    .positive('the file is empty')
    .max(MUSIC_MAX_BYTES, `larger than ${MUSIC_MAX_BYTES / 1024 / 1024} MB`),
});
export type BedUpload = z.infer<typeof BedUploadSchema>;

/** The object key for a bed. Built here, never accepted from a client. */
export function musicKey(channelId: string, bedId: string, contentType: MusicContentType): string {
  return storageKeySchema.parse(`music/${channelId}/${bedId}.${MUSIC_CONTENT_TYPES[contentType]}`);
}

export type PlanResult = { ok: true; key: string; upload: BedUpload } | { ok: false; problem: string };

/** Validate an upload before anything is presigned: the bed must be in this channel's pool. */
export function planBedUpload(args: { channelId: string; cb: ChannelBible; input: unknown }): PlanResult {
  const parsed = BedUploadSchema.safeParse(args.input);
  if (!parsed.success) return { ok: false, problem: `Refused: ${parsed.error.issues.map((i) => i.message).join('; ')}.` };
  const pool = bedPool(args.cb);
  if (!pool.has(parsed.data.bedId)) {
    return {
      ok: false,
      problem: `Refused: "${parsed.data.bedId}" is not in any ${args.cb.slug} series' music_bed_pool. Add it to channels/${args.cb.slug}/series/*.json first.`,
    };
  }
  return { ok: true, key: musicKey(args.channelId, parsed.data.bedId, parsed.data.contentType), upload: parsed.data };
}

export type ConfirmResult =
  | { ok: true; verified: false; message: string }
  | { ok: false; problem: string };

/** Record the music_beds row after the browser's PUT. Re-validates everything; rebuilds the key. */
export async function confirmBedUpload(
  db: Db,
  args: { channelId: string; cb: ChannelBible; input: unknown },
): Promise<ConfirmResult> {
  const plan = planBedUpload(args);
  if (!plan.ok) return plan;
  const { error } = await db.from('music_beds').upsert(
    {
      channel_id: args.channelId,
      bed_id: plan.upload.bedId,
      storage_key: plan.key,
      content_type: plan.upload.contentType,
      bytes: plan.upload.bytes,
      uploaded_at: new Date().toISOString(),
    },
    { onConflict: 'channel_id,bed_id' },
  );
  if (error) return { ok: false, problem: isMissingTable(error) ? `Not recorded: ${NEEDS_0046}.` : `Not recorded: ${error.message}` };
  return {
    ok: true,
    verified: false,
    message:
      `Recorded ${plan.upload.bedId} — unverified: the browser reported the upload succeeded, and the storage ` +
      'driver has no way to check an object exists. Play it below to confirm.',
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Default per series
// ═════════════════════════════════════════════════════════════════════════════

export async function setSeriesDefault(
  db: Db,
  args: { channelId: string; cb: ChannelBible; series: string; bedId: string },
): Promise<{ ok: true; message: string } | { ok: false; problem: string }> {
  const s = args.cb.series[args.series as SeriesId];
  if (!s) return { ok: false, problem: `Not set: channel ${args.cb.slug} runs no series "${args.series}".` };
  if (!s.music_bed_pool.includes(args.bedId)) {
    return { ok: false, problem: `Not set: "${args.bedId}" is not in the ${s.name} music_bed_pool (${s.music_bed_pool.join(', ')}).` };
  }
  const { data: bed, error: readError } = await db
    .from('music_beds')
    .select('bed_id')
    .eq('channel_id', args.channelId)
    .eq('bed_id', args.bedId)
    .maybeSingle();
  if (readError) return { ok: false, problem: isMissingTable(readError) ? `Not set: ${NEEDS_0046}.` : `Not set: ${readError.message}` };
  if (!bed) return { ok: false, problem: `Not set: "${args.bedId}" has no audio uploaded on this channel. Upload it first.` };

  const { error } = await db
    .from('music_bed_defaults')
    .upsert({ channel_id: args.channelId, series: s.id, bed_id: args.bedId, set_at: new Date().toISOString() }, { onConflict: 'channel_id,series' });
  if (error) return { ok: false, problem: isMissingTable(error) ? `Not set: ${NEEDS_0046}.` : `Not set: ${error.message}` };
  return { ok: true, message: `${s.name} defaults to ${args.bedId}.` };
}
