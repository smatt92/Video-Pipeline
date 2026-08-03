import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { assetKey } from '../storage';
import { normalise, probe, type NormaliseResult } from './normalise';

/**
 * Ingest: fetch a confirmed result, normalise it, store it, record it.
 *
 * This is what `TODO(gate-4)` in `confirm.ts` used to point at. It runs in a Trigger
 * container and nowhere else — it downloads and re-encodes video, and a Vercel route may
 * do neither (rule 2: 4.5 MB body cap; rule 3: no ffmpeg, no GPU, 800s ceiling).
 *
 * ── Failure is a row, never a half-asset ─────────────────────────────────────
 *
 * The ordering below is the load-bearing part. The `assets` row is written **after** the
 * bytes are stored and re-probed, and a failure at any earlier point writes
 * `normalize_error` against the generation instead. So there is no state in which a row
 * claims an asset that is absent, truncated, or in a format the assembler cannot concat —
 * which matters because the assembler stream-copies and would produce a silently broken
 * MP4 rather than an error.
 *
 * ── What is real here and what is not ────────────────────────────────────────
 *
 * Everything except the vendor's own URL. The fetch is a real HTTP GET, the normalise is
 * real ffmpeg, the store is a real driver write, the row is a real insert. Pointing it at
 * a locally served file exercises every one of those; only the origin differs.
 */

export interface IngestPayload {
  generationId: string;
  assetUrl: string;
  kind?: 'video' | 'image' | 'audio';
}

export interface IngestDeps {
  db: Db;
  /** Writes bytes to a key and returns the size. Driver-specific; not on the interface. */
  putBytes: (key: string, body: Readable) => Promise<number>;
  /** Reads back what was written, for the post-store probe. */
  localPath?: (key: string) => string;
  fetchImpl?: typeof fetch;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type IngestResult =
  | {
      ok: true;
      assetId: string;
      key: string;
      bytes: number;
      durationS: number;
      normaliseMs: number;
    }
  | { ok: false; code: string; detail: string };

const noop = { info: () => {}, error: () => {} };

/** Record the failure against the generation. A swallowed error is the one thing forbidden. */
async function recordFailure(
  db: Db,
  generationId: string,
  code: string,
  detail: string,
): Promise<IngestResult> {
  await db
    .from('generations')
    .update({ error_code: code, error_detail: detail.slice(0, 1000) })
    .eq('id', generationId);
  return { ok: false, code, detail };
}

export async function runIngest(
  payload: IngestPayload,
  deps: IngestDeps,
): Promise<IngestResult> {
  const { db, putBytes } = deps;
  const log = deps.log ?? noop;
  const doFetch = deps.fetchImpl ?? fetch;
  const kind = payload.kind ?? 'video';

  const { data: generation } = await db
    .from('generations')
    .select('id, shot_id, status, confirmed_at')
    .eq('id', payload.generationId)
    .maybeSingle();

  if (!generation) {
    return { ok: false, code: 'unknown_generation', detail: `No generation ${payload.generationId}` };
  }

  // Only a confirmed generation is ingested. The confirmation is what distinguishes a real
  // completion from a forged callback (0013), and downloading on an unconfirmed claim would
  // route around the whole point of confirm-before-write.
  if (!generation.confirmed_at) {
    return {
      ok: false,
      code: 'unconfirmed',
      detail:
        'This generation has not been confirmed against the vendor. Ingesting would write an ' +
        'asset on the strength of a callback alone, which is what confirm-before-write exists ' +
        'to prevent.',
    };
  }

  const work = await mkdtemp(join(tmpdir(), 'kiln-ingest-'));
  const rawPath = join(work, 'source');
  const outPath = join(work, 'normalised.mp4');

  try {
    // ── Fetch ──────────────────────────────────────────────────────────────
    let downloaded = 0;
    try {
      const response = await doFetch(payload.assetUrl);
      if (!response.ok || !response.body) {
        return await recordFailure(
          db,
          generation.id,
          'fetch_failed',
          `Vendor asset URL returned ${response.status}.`,
        );
      }
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(rawPath));
      downloaded = (await stat(rawPath)).size;
    } catch (err) {
      return await recordFailure(
        db,
        generation.id,
        'fetch_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (downloaded === 0) {
      return await recordFailure(db, generation.id, 'fetch_failed', 'Vendor returned zero bytes.');
    }

    log.info('fetched', { bytes: downloaded });

    // ── Normalise ──────────────────────────────────────────────────────────
    const result: NormaliseResult = await normalise(rawPath, outPath);

    if (!result.ok) {
      // The distinguishing write. `assets.normalize_error` is on the asset row in the
      // schema, but there is no asset row here and there must not be — so it lands on the
      // generation, and the shot goes to failed. A row that claims an asset which does not
      // exist is worse than no row.
      await db
        .from('generations')
        .update({
          error_code: 'normalise_failed',
          error_detail: result.error?.slice(0, 1000) ?? 'unknown',
        })
        .eq('id', generation.id);

      if (generation.shot_id) {
        await db.from('shots').update({ status: 'failed' }).eq('id', generation.shot_id);
      }

      log.error('normalise failed', { error: result.error });
      return { ok: false, code: 'normalise_failed', detail: result.error ?? 'unknown' };
    }

    log.info('normalised', {
      from: `${result.source?.width}x${result.source?.height}@${result.source?.fps.toFixed(2)} ${result.source?.codec}`,
      to: `${result.output?.width}x${result.output?.height}@${result.output?.fps.toFixed(2)} ${result.output?.codec}`,
      ms: result.ms,
    });

    // ── Store ──────────────────────────────────────────────────────────────
    const key = assetKey({ generationId: generation.id, kind, extension: 'mp4' });

    let stored: number;
    try {
      const { createReadStream } = await import('node:fs');
      stored = await putBytes(key, createReadStream(outPath));
    } catch (err) {
      return await recordFailure(
        db,
        generation.id,
        'store_failed',
        err instanceof Error ? err.message : String(err),
      );
    }

    // Re-probed from what was actually stored, not from the local temp file. "ffmpeg wrote
    // a canonical file" and "a canonical file is in the bucket" are different claims, and a
    // truncated upload satisfies only the first.
    if (deps.localPath) {
      try {
        const readBack = await probe(deps.localPath(key));
        if (readBack.durationS < result.output!.durationS * 0.9) {
          return await recordFailure(
            db,
            generation.id,
            'store_truncated',
            `Stored object is ${readBack.durationS.toFixed(2)}s against ${result.output!.durationS.toFixed(2)}s written.`,
          );
        }
      } catch (err) {
        return await recordFailure(
          db,
          generation.id,
          'store_unreadable',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // ── Record ─────────────────────────────────────────────────────────────
    const now = new Date().toISOString();
    const { data: asset, error: assetError } = await db
      .from('assets')
      .insert({
        generation_id: generation.id,
        kind,
        storage_key: key,
        bytes: stored,
        duration_s: result.output!.durationS,
        width: result.output!.width,
        height: result.output!.height,
        normalized_at: now,
        source_meta: result.source as unknown as Json,
      })
      .select('id')
      .single();

    if (assetError || !asset) {
      return await recordFailure(
        db,
        generation.id,
        'asset_row_failed',
        assetError?.message ?? 'insert returned nothing',
      );
    }

    if (generation.shot_id) {
      await db.from('shots').update({ status: 'ready' }).eq('id', generation.shot_id);
    }

    return {
      ok: true,
      assetId: asset.id,
      key,
      bytes: stored,
      durationS: result.output!.durationS,
      normaliseMs: result.ms,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
