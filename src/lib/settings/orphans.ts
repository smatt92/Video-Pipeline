import type { Db } from '../db/server';

/**
 * Orphaned assets — `assets` rows (and their stored bytes) that nothing points at any more.
 * Settings → Danger zone lists them (a dry run, from Vercel: ids and sizes only); deleting
 * them is the worker's job (`src/trigger/99-purge-orphans.ts`), because rule 2/3 keep every
 * byte-touching call off Vercel, and the worker re-runs THIS finder before it deletes, so a
 * row that gained a reference between the dry run and the purge is kept.
 *
 * ── What counts as a reference ───────────────────────────────────────────────
 *
 * Generous on purpose: a false orphan deletes a paid-for file; a missed one costs a few MB.
 *
 *   1. every foreign key into assets — ASSET_FOREIGN_KEYS, which `verify:settings` checks
 *      against `pg_constraint` on a migrated database, so a new FK cannot be missed silently;
 *   2. `generation_id` set — a clip or still belongs to its generation (and so to its shot);
 *   3. the asset's id or storage key appearing anywhere in the jsonb that carries asset
 *      pointers without a foreign key: episodes.voice_detail (the VO track, the loud track,
 *      the SRT) and .qc, publications.bundle, shots.compiled_params / overlay_spec;
 *   4. music — a library upload is referenced by a person, not by a row; never an orphan;
 *   5. anything younger than ORPHAN_MIN_AGE_H — a running stage inserts the asset a moment
 *      before it writes the pointer to it.
 */

export const ASSET_FOREIGN_KEYS = [
  { table: 'renders', column: 'asset_id' },
  { table: 'publications', column: 'thumbnail_asset_id' },
  { table: 'vo_takes', column: 'asset_id' },
  { table: 'dub_jobs', column: 'audio_asset_id' },
  { table: 'dub_jobs', column: 'srt_asset_id' },
] as const;

/** jsonb columns that carry asset ids or storage keys without a foreign key. */
export const ASSET_JSON_POINTERS = [
  { table: 'episodes', columns: ['voice_detail', 'qc'] },
  { table: 'publications', columns: ['bundle'] },
  { table: 'shots', columns: ['compiled_params', 'overlay_spec'] },
] as const;

export const ORPHAN_MIN_AGE_H = 48;
const PAGE = 1000;

export interface OrphanAsset {
  id: string;
  kind: string;
  storageKey: string;
  /** Null when the row never recorded a size — shown as "—", never summed as 0. */
  bytes: number | null;
  createdAt: string;
}

export interface OrphanReport {
  orphans: OrphanAsset[];
  /** Sum of the known sizes. */
  knownBytes: number;
  /** How many orphans have no recorded size (so knownBytes is a lower bound). */
  unknownSize: number;
  scanned: number;
}

type Row = Record<string, unknown>;

async function allRows(db: Db, table: string, columns: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    // The table names here come from the two constant lists above, never from input.
    // Ordered by id: a page window over an unordered result can skip or repeat rows.
    const { data, error } = await (db.from(table as never) as unknown as {
      select(c: string): { order(c: string): { range(a: number, b: number): Promise<{ data: Row[] | null; error: { message: string } | null }> } };
    })
      .select(columns)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Reading ${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

/** Every asset nothing references, oldest first. Read-only. */
export async function findOrphans(db: Db, now: number = Date.now()): Promise<OrphanReport> {
  const assets = await allRows(db, 'assets', 'id, kind, storage_key, bytes, generation_id, created_at');

  const referenced = new Set<string>();
  for (const fk of ASSET_FOREIGN_KEYS) {
    for (const r of await allRows(db, fk.table, fk.column)) {
      const v = r[fk.column];
      if (typeof v === 'string') referenced.add(v);
    }
  }
  const texts: string[] = [];
  for (const p of ASSET_JSON_POINTERS) {
    for (const r of await allRows(db, p.table, p.columns.join(', '))) {
      for (const c of p.columns) if (r[c] !== null && r[c] !== undefined) texts.push(JSON.stringify(r[c]));
    }
  }
  const blob = texts.join('\n');
  const cutoff = now - ORPHAN_MIN_AGE_H * 3_600_000;

  const orphans: OrphanAsset[] = [];
  for (const a of assets) {
    const id = String(a.id);
    const key = String(a.storage_key);
    if (referenced.has(id)) continue;
    if (a.generation_id) continue;
    if (a.kind === 'music') continue;
    if (Date.parse(String(a.created_at)) > cutoff) continue;
    if (blob.includes(id) || (key && blob.includes(key))) continue;
    // bytes is bigint, so it arrives as a string. Number() is a decision: one file's size is
    // far below 2^53.
    orphans.push({ id, kind: String(a.kind), storageKey: key, bytes: a.bytes === null || a.bytes === undefined ? null : Number(a.bytes), createdAt: String(a.created_at) });
  }
  orphans.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  return {
    orphans,
    knownBytes: orphans.reduce((n, o) => n + (o.bytes ?? 0), 0),
    unknownSize: orphans.filter((o) => o.bytes === null).length,
    scanned: assets.length,
  };
}

export interface PurgeOutcome {
  deleted: string[];
  /** Asked for, but no longer an orphan (or gone) when the worker looked again. */
  kept: string[];
  failed: { id: string; reason: string }[];
  bytes: number;
}

/**
 * Delete the requested orphans that are STILL orphans: bytes first, then the row, so a
 * failure never leaves a row pointing at nothing. The worker calls this; `deleteKey` is its
 * storage driver's delete (idempotent — an absent key succeeds).
 */
export async function purgeOrphans(db: Db, ids: readonly string[], deleteKey: (key: string) => Promise<void>): Promise<PurgeOutcome> {
  const now = await findOrphans(db);
  const still = new Map(now.orphans.map((o) => [o.id, o]));
  const out: PurgeOutcome = { deleted: [], kept: [], failed: [], bytes: 0 };
  for (const id of ids) {
    const o = still.get(id);
    if (!o) {
      out.kept.push(id);
      continue;
    }
    try {
      await deleteKey(o.storageKey);
      const { error } = await db.from('assets').delete().eq('id', id);
      if (error) throw new Error(error.message);
      out.deleted.push(id);
      out.bytes += o.bytes ?? 0;
    } catch (err) {
      out.failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
