import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { Db } from '../db/server';
import { CANONICAL } from '../ingest/normalise';
import { storageKeySchema } from '../storage';
import { assembleRoughCut, type ClipInput } from './rough-cut';

/**
 * Stage 7 — assemble a rough cut from a script's normalised shots.
 *
 * Reads the shots in `idx` order, resolves each one's most recent ready asset, concatenates
 * them, stores the result and writes a `renders` row with `kind = 'rough_cut'`.
 *
 * ── Failure states are rows ──────────────────────────────────────────────────
 *
 * A refusal writes a `renders` row with `status = 'failed'` rather than returning quietly.
 * The reason is the review screen: "no rough cut yet" and "the rough cut was attempted and
 * these two shots were not normalised" are different things for a person to see, and only
 * the second one tells them what to do.
 */

export interface AssemblePayload {
  scriptId: string;
  variantLabel?: string;
}

export interface AssembleDeps {
  db: Db;
  /** Local path for a stored key, so ffmpeg can read it. */
  localPath: (key: string) => string;
  putBytes: (key: string, body: Readable) => Promise<number>;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type AssembleRunResult =
  | { ok: true; renderId: string; assetId: string; key: string; durationS: number; clips: number; renderMs: number }
  | { ok: false; code: string; detail: string; renderId: string | null };

const noop = { info: () => {}, error: () => {} };

export async function runAssemble(
  payload: AssemblePayload,
  deps: AssembleDeps,
): Promise<AssembleRunResult> {
  const { db, localPath, putBytes } = deps;
  const log = deps.log ?? noop;
  const variantLabel = payload.variantLabel ?? 'rough';

  const { data: script } = await db
    .from('scripts')
    .select('id, concept_id')
    .eq('id', payload.scriptId)
    .maybeSingle();

  if (!script) {
    return { ok: false, code: 'unknown_script', detail: `No script ${payload.scriptId}`, renderId: null };
  }

  const { data: shots } = await db
    .from('shots')
    .select('id, idx, status')
    .eq('script_id', script.id)
    .order('idx');

  if (!shots || shots.length === 0) {
    return { ok: false, code: 'no_shots', detail: 'This script has no shots.', renderId: null };
  }

  // Assets, resolved per shot through its generations. Newest ready asset wins, so a
  // regenerated shot assembles with its replacement rather than its first attempt.
  const { data: generations } = await db
    .from('generations')
    .select('id, shot_id, status')
    .in(
      'shot_id',
      shots.map((s) => s.id),
    );

  const { data: assets } = await db
    .from('assets')
    .select('id, generation_id, storage_key, duration_s, normalized_at, created_at')
    .in(
      'generation_id',
      (generations ?? []).map((g) => g.id),
    )
    .order('created_at', { ascending: false });

  const genToShot = new Map((generations ?? []).map((g) => [g.id, g.shot_id]));
  const shotToAsset = new Map<string, { key: string; id: string; normalized: boolean }>();

  for (const asset of assets ?? []) {
    const shotId = asset.generation_id ? genToShot.get(asset.generation_id) : null;
    if (!shotId || shotToAsset.has(shotId)) continue; // newest first, so the first wins
    shotToAsset.set(shotId, {
      key: asset.storage_key,
      id: asset.id,
      normalized: asset.normalized_at !== null,
    });
  }

  const missing = shots.filter((s) => !shotToAsset.has(s.id));
  if (missing.length > 0) {
    const renderId = await failedRender(
      db,
      script.id,
      variantLabel,
      `${missing.length} of ${shots.length} shots have no asset: ${missing.map((s) => `shot ${s.idx}`).join(', ')}.`,
    );
    return {
      ok: false,
      code: 'missing_assets',
      detail: `Shots ${missing.map((s) => s.idx).join(', ')} have no ingested asset.`,
      renderId,
    };
  }

  const clips: ClipInput[] = shots.map((s) => {
    const asset = shotToAsset.get(s.id)!;
    return { path: localPath(storageKeySchema.parse(asset.key)), label: `shot ${s.idx}` };
  });

  const work = await mkdtemp(join(tmpdir(), 'kiln-assemble-'));
  const outPath = join(work, 'rough-cut.mp4');

  try {
    const result = await assembleRoughCut({ clips, outputPath: outPath, workDir: work });

    if (!result.ok) {
      const renderId = await failedRender(db, script.id, variantLabel, result.detail);
      log.error('assemble refused', { code: result.code });
      return { ok: false, code: result.code, detail: result.detail, renderId };
    }

    // Stored under the script, not a generation — a render is not a generation's output.
    const key = storageKeySchema.parse(`renders/${script.id}/${variantLabel}.mp4`);
    const { createReadStream } = await import('node:fs');
    const bytes = await putBytes(key, createReadStream(outPath));

    const { data: asset, error: assetError } = await db
      .from('assets')
      .insert({
        kind: 'video',
        storage_key: key,
        bytes,
        duration_s: result.durationS,
        width: CANONICAL.width,
        height: CANONICAL.height,
        normalized_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (assetError || !asset) {
      const renderId = await failedRender(
        db,
        script.id,
        variantLabel,
        `Asset row failed: ${assetError?.message}`,
      );
      return { ok: false, code: 'asset_row_failed', detail: assetError?.message ?? '', renderId };
    }

    const { data: render, error: renderError } = await db
      .from('renders')
      .insert({
        script_id: script.id,
        variant_group_id: script.id,
        variant_label: variantLabel,
        kind: 'rough_cut',
        status: 'ready',
        asset_id: asset.id,
        width: CANONICAL.width,
        height: CANONICAL.height,
        // The delivery format, not the container — the CHECK constraint in 0001 lists
        // 'shorts_9x16' | 'reels_9x16' | 'longform_16x9'. Writing 'mp4' here was caught
        // by the constraint on the first real insert, which is the constraint doing its
        // job: the column answers "which surface is this cut for?", and the canonical
        // intermediate is 1080x1920, so it is the vertical one.
        format: 'shorts_9x16',
        duration_s: result.durationS,
        render_ms: result.renderMs,
        origin: 'pipeline',
      })
      .select('id')
      .single();

    if (renderError || !render) {
      return {
        ok: false,
        code: 'render_row_failed',
        detail: renderError?.message ?? '',
        renderId: null,
      };
    }

    log.info('rough cut assembled', {
      clips: result.clips,
      durationS: result.durationS,
      renderMs: result.renderMs,
      bytes,
    });

    return {
      ok: true,
      renderId: render.id,
      assetId: asset.id,
      key,
      durationS: result.durationS,
      clips: result.clips,
      renderMs: result.renderMs,
    };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** A refusal is a row. The review screen needs to show what was attempted and why it stopped. */
async function failedRender(
  db: Db,
  scriptId: string,
  variantLabel: string,
  detail: string,
): Promise<string | null> {
  const { data } = await db
    .from('renders')
    .insert({
      script_id: scriptId,
      variant_group_id: scriptId,
      variant_label: variantLabel,
      kind: 'rough_cut',
      status: 'failed',
      width: CANONICAL.width,
      height: CANONICAL.height,
      format: 'shorts_9x16',
      origin: 'pipeline',
    })
    .select('id')
    .single();

  if (data) {
    // The detail belongs somewhere durable; `renders` has no error column, so it lands on
    // the shot statuses and in the log. Recorded here as a known gap rather than dropped:
    // a renders.error_detail column is the right fix and is not in this migration.
    console.error('[assemble] refused', { scriptId, renderId: data.id, detail });
  }

  return data?.id ?? null;
}
