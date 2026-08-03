import 'server-only';

import type { Db } from '../db/server';
import type { WordTiming } from '../voice/timings';
import { buildTimeline, mergeTakes, type Timeline, type TimelineShot } from './timeline';

/**
 * What the review screen reads.
 *
 * Three outcomes, like the board and the Studio list: a render, nothing to review, or a
 * broken query. The distinction between the last two is the whole reason this returns a
 * result type — a review screen that renders empty when the query failed is a screen that
 * says "nothing needs your attention" about a database it could not reach.
 *
 * ── Media is URLs, never bytes ───────────────────────────────────────────────
 *
 * The render and the voiceover are handed to the browser as presigned GETs, signed here in
 * a Server Component. Rule 2: browser↔bucket directly, and nothing media-shaped passes
 * through a Vercel function. The player and wavesurfer both fetch from the bucket.
 */

export interface ReviewRender {
  id: string;
  scriptId: string;
  conceptId: string;
  conceptTitle: string;
  variantLabel: string;
  kind: string;
  format: string;
  status: string;
  width: number;
  height: number;
  /** What the render actually is, as measured at assembly. */
  durationS: number | null;
  createdAt: string;
  /** Presigned. Null when the render has no asset — a failed or queued render. */
  videoUrl: string | null;
}

export interface ReviewVoice {
  /** Presigned. Null when no VO asset exists yet. */
  audioUrl: string | null;
  words: WordTiming[];
  voText: string;
  takes: number;
}

export interface ReviewNovelty {
  structureHash: string;
  sharedWith: number;
  /** True for a Studio stub hash: unique by construction, so uniqueness proves nothing. */
  unmeasured: boolean;
}

export interface ReviewDetail {
  render: ReviewRender;
  timeline: Timeline;
  voice: ReviewVoice;
  novelty: ReviewNovelty;
  humanEditCount: number;
  current: {
    id: string;
    decision: string;
    notes: string | null;
    reshootShotIds: string[];
    createdAt: string;
  } | null;
  history: { id: string; decision: string; createdAt: string; notes: string | null }[];
}

export type ReviewRead = { ok: true; detail: ReviewDetail } | { ok: false; detail: string };

export interface Presigner {
  presignGet(params: { key: string; expiresIn: number }): Promise<{ url: string }>;
}

/** Long enough to watch a short several times; short enough that a leaked URL expires. */
const URL_TTL_S = 3600;

export async function readReview(
  db: Db,
  renderId: string,
  storage: Presigner,
): Promise<ReviewRead> {
  const { data: render, error } = await db
    .from('renders')
    .select('id, script_id, variant_label, kind, format, status, width, height, duration_s, asset_id, created_at')
    .eq('id', renderId)
    .maybeSingle();

  if (error) return { ok: false, detail: `Reading the render failed: ${error.message}` };
  if (!render) return { ok: false, detail: `No render ${renderId}.` };

  const { data: script } = await db
    .from('scripts')
    .select('id, concept_id, vo_text, human_edit_count, structure_hash')
    .eq('id', render.script_id)
    .maybeSingle();

  if (!script) return { ok: false, detail: `Render ${renderId} points at a script that is gone.` };

  const { data: concept } = await db
    .from('concepts')
    .select('id, title')
    .eq('id', script.concept_id)
    .maybeSingle();

  // ── Shots, with the asset each one resolves to ────────────────────────────
  const { data: shotRows } = await db
    .from('shots')
    .select('id, idx, description, duration_s, effective_duration_s, trim_in_s, trim_out_s, status, vo_char_start, vo_char_end, duration_source')
    .eq('script_id', script.id)
    .order('idx');

  const shotIds = (shotRows ?? []).map((s) => s.id);

  const { data: generations } = shotIds.length
    ? await db.from('generations').select('id, shot_id').in('shot_id', shotIds)
    : { data: [] };

  const genIds = (generations ?? []).map((g) => g.id);

  const { data: assets } = genIds.length
    ? await db
        .from('assets')
        .select('id, generation_id, storage_key, kind, normalized_at, created_at')
        .in('generation_id', genIds)
        .order('created_at', { ascending: false })
    : { data: [] };

  const genToShot = new Map((generations ?? []).map((g) => [g.id, g.shot_id]));
  const shotToAsset = new Map<string, { key: string; normalised: boolean }>();
  for (const asset of assets ?? []) {
    const shotId = asset.generation_id ? genToShot.get(asset.generation_id) : null;
    if (!shotId || shotToAsset.has(shotId)) continue; // newest first, so the first wins
    shotToAsset.set(shotId, { key: asset.storage_key, normalised: asset.normalized_at !== null });
  }

  const shots: TimelineShot[] = (shotRows ?? []).map((s) => {
    const asset = shotToAsset.get(s.id);
    return {
      id: s.id,
      idx: s.idx,
      description: s.description,
      durationS: Number(s.duration_s),
      effectiveDurationS: Number(s.effective_duration_s ?? s.duration_s),
      trimInS: s.trim_in_s === null ? null : Number(s.trim_in_s),
      trimOutS: s.trim_out_s === null ? null : Number(s.trim_out_s),
      status: s.status,
      voCharStart: s.vo_char_start,
      voCharEnd: s.vo_char_end,
      durationSource: s.duration_source,
      assetKey: asset?.key ?? null,
      normalised: asset?.normalised ?? false,
    };
  });

  // ── Voice ─────────────────────────────────────────────────────────────────
  const { data: takes } = await db
    .from('vo_takes')
    .select('id, chunk_idx, offset_s, word_timings, asset_id')
    .eq('script_id', script.id)
    .order('chunk_idx');

  const words = mergeTakes(
    (takes ?? []).map((t) => ({
      chunkIdx: t.chunk_idx,
      offsetS: Number(t.offset_s),
      words: parseWordTimings(t.word_timings),
    })),
  );

  const timeline = buildTimeline(shots, script.vo_text, words);

  // ── Novelty ───────────────────────────────────────────────────────────────
  const { data: novelty } = await db
    .from('v_script_structure_novelty')
    .select('structure_hash, shared_with, unmeasured')
    .eq('script_id', script.id)
    .maybeSingle();

  // ── Reviews ───────────────────────────────────────────────────────────────
  const { data: reviews } = await db
    .from('reviews')
    .select('id, decision, notes, reshoot_shot_ids, created_at')
    .eq('render_id', render.id)
    .order('created_at', { ascending: false });

  const history = (reviews ?? []).map((r) => ({
    id: r.id,
    decision: r.decision,
    createdAt: String(r.created_at),
    notes: r.notes,
  }));

  // ── Presigned media ───────────────────────────────────────────────────────
  const videoKey = render.asset_id ? await assetKey(db, render.asset_id) : null;
  const voAssetId = (takes ?? []).find((t) => t.asset_id)?.asset_id ?? null;
  const voKey = voAssetId ? await assetKey(db, voAssetId) : null;

  return {
    ok: true,
    detail: {
      render: {
        id: render.id,
        scriptId: script.id,
        conceptId: script.concept_id,
        conceptTitle: concept?.title ?? 'Untitled concept',
        variantLabel: render.variant_label,
        kind: render.kind,
        format: render.format,
        status: render.status,
        width: render.width,
        height: render.height,
        durationS: render.duration_s === null ? null : Number(render.duration_s),
        createdAt: String(render.created_at),
        videoUrl: videoKey ? await presign(storage, videoKey) : null,
      },
      timeline,
      voice: {
        audioUrl: voKey ? await presign(storage, voKey) : null,
        words,
        voText: script.vo_text,
        takes: takes?.length ?? 0,
      },
      novelty: {
        structureHash: script.structure_hash,
        sharedWith: Number(novelty?.shared_with ?? 0),
        unmeasured: novelty?.unmeasured ?? script.structure_hash.startsWith('studio-stub:'),
      },
      humanEditCount: script.human_edit_count,
      current: reviews?.[0]
        ? {
            id: reviews[0].id,
            decision: reviews[0].decision,
            notes: reviews[0].notes,
            reshootShotIds: reviews[0].reshoot_shot_ids ?? [],
            createdAt: String(reviews[0].created_at),
          }
        : null,
      history,
    },
  };
}

async function assetKey(db: Db, assetId: string): Promise<string | null> {
  const { data } = await db.from('assets').select('storage_key').eq('id', assetId).maybeSingle();
  return data?.storage_key ?? null;
}

/**
 * A failed presign is null, not a throw.
 *
 * The screen has plenty to say without the video — the drift, the shot statuses, the
 * novelty — and a storage misconfiguration should not take the whole page down. The player
 * renders its own "the render is not reachable" state instead.
 */
async function presign(storage: Presigner, key: string): Promise<string | null> {
  try {
    const { url } = await storage.presignGet({ key, expiresIn: URL_TTL_S });
    return url;
  } catch (err) {
    console.error('[review] presign failed', { key, err });
    return null;
  }
}

/** `word_timings` is jsonb. Validated on shape rather than cast — CLAUDE.md forbids the cast. */
function parseWordTimings(value: unknown): WordTiming[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (w): w is WordTiming =>
      !!w &&
      typeof w === 'object' &&
      typeof (w as WordTiming).w === 'string' &&
      typeof (w as WordTiming).start === 'number' &&
      typeof (w as WordTiming).end === 'number',
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The queue
// ═════════════════════════════════════════════════════════════════════════════

export interface QueueRow {
  renderId: string;
  conceptTitle: string;
  variantLabel: string;
  status: string;
  kind: string;
  durationS: number | null;
  createdAt: string;
  decision: string | null;
}

export type QueueRead = { ok: true; rows: QueueRow[] } | { ok: false; detail: string };

export async function readQueue(db: Db): Promise<QueueRead> {
  const { data, error } = await db
    .from('renders')
    .select('id, script_id, variant_label, kind, status, duration_s, created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return { ok: false, detail: error.message };

  const scriptIds = [...new Set((data ?? []).map((r) => r.script_id))];
  const { data: scripts } = scriptIds.length
    ? await db.from('scripts').select('id, concept_id').in('id', scriptIds)
    : { data: [] };

  const conceptIds = [...new Set((scripts ?? []).map((s) => s.concept_id))];
  const { data: concepts } = conceptIds.length
    ? await db.from('concepts').select('id, title').in('id', conceptIds)
    : { data: [] };

  const { data: current } = await db.from('v_current_review').select('render_id, decision');

  const scriptToConcept = new Map((scripts ?? []).map((s) => [s.id, s.concept_id]));
  const conceptTitle = new Map((concepts ?? []).map((c) => [c.id, c.title]));
  const decisions = new Map((current ?? []).map((r) => [r.render_id, r.decision]));

  return {
    ok: true,
    rows: (data ?? []).map((r) => ({
      renderId: r.id,
      conceptTitle: conceptTitle.get(scriptToConcept.get(r.script_id) ?? '') ?? 'Untitled',
      variantLabel: r.variant_label,
      status: r.status,
      kind: r.kind,
      durationS: r.duration_s === null ? null : Number(r.duration_s),
      createdAt: String(r.created_at),
      decision: decisions.get(r.id) ?? null,
    })),
  };
}
