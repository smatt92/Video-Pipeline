import { createHash } from 'node:crypto';

import { getBible } from '../bureau/bible';
import type { Embedder } from '../bureau/embed';
import type { Db } from '../db/server';
import type { Json } from '../db/types';

/**
 * Stage 1 — how relevant each signal is to THIS channel (Prompt O5 B, migration 0051).
 *
 * ── What is compared with what ───────────────────────────────────────────────
 *
 * A term's embedding against the channel's niche vector: the normalised mean of the
 * embeddings of the bible premise, every series ("name: template") and the topic calendar's
 * topics. Cosine similarity, written to `trend_signals.relevance`. One vector per channel,
 * stored in `channel_niche_vectors` with a hash of the texts it came from, and rebuilt only
 * when that hash changes — a page view never embeds anything.
 *
 * ── Each term once ───────────────────────────────────────────────────────────
 *
 * `trend_term_embeddings` is keyed by the term's text. The same headline captured four times a
 * day, or by two channels, is one embedding; only terms never seen before reach the vendor.
 *
 * ── Absent is not zero ───────────────────────────────────────────────────────
 *
 * A term that cannot be embedded — no embedder configured, the free tier's 429 outlasting the
 * back-off, the niche unbuildable — keeps `relevance = NULL` and the reason is returned (and
 * recorded on the run). Never 0: 0 would claim the term was measured as orthogonal to the
 * channel, and a reader filtering "relevance ≥ t" would drop a term nobody looked at.
 *
 * ── The money ────────────────────────────────────────────────────────────────
 *
 * The embedder passed in is `ledgeredEmbedder` (bureau/embed.ts): the free-tier key priced at
 * the paid rate, one estimate row per call, written before the call — decision 0015's rule for
 * every embedding, kept here rather than making trends the one embedder that skips it.
 */

/** Calls are batched; the vendor's batch endpoint takes up to 100 texts. */
const BATCH = 100;
/**
 * Terms per `in (…)` read. Lower than BATCH: the read is a GET whose URL carries every term,
 * and a hundred headlines URL-encoded would pass the gateway's URL limit long before the API's.
 */
const READ_BATCH = 25;
/** The calendar topics that go into the niche — the most recent by slot date. */
const MAX_TOPICS = 60;

export interface RelevanceOutcome {
  /** Signals given a score this run. */
  readonly scored: number;
  /** Signals left NULL this run, and why (null when every one was scored). */
  readonly unscored: number;
  readonly detail: string | null;
  /** Terms sent to the vendor this run (the rest were already embedded). */
  readonly embedded: number;
  readonly nicheRebuilt: boolean;
}

/** The texts a channel's niche is built from. Pure of the vendor; the harness reads it too. */
export async function nicheTexts(db: Db, channelId: string): Promise<string[]> {
  const out: string[] = [];
  const { data: ch } = await db.from('channels').select('name, niche').eq('id', channelId).maybeSingle();
  if (ch?.niche) out.push(`${ch.name}: ${ch.niche}`);
  try {
    const cb = await getBible(db, channelId);
    if (cb.bible.world.premise.trim()) out.push(cb.bible.world.premise.trim());
    for (const s of Object.values(cb.series)) if (s) out.push(`${s.name}: ${s.template}`);
  } catch {
    // A channel with no bible has only its niche line and calendar; said by the outcome if empty.
  }
  const { data: slots } = await db.from('slots').select('topic, slot_date').eq('channel_id', channelId).order('slot_date', { ascending: false }).limit(400);
  const topics = new Set<string>();
  for (const s of slots ?? []) {
    const t = (s.topic ?? '').trim();
    if (t && !topics.has(t)) topics.add(t);
    if (topics.size >= MAX_TOPICS) break;
  }
  out.push(...topics);
  return out;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The normalised mean — a unit vector pointing at the niche's centre. */
export function centroid(vectors: readonly number[][]): number[] {
  const out = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    for (let i = 0; i < v.length; i++) out[i] += v[i] / n;
  }
  const n = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
  return out.map((x) => x / n);
}

/** pgvector crosses the wire as its text form "[0.1,0.2,…]". */
export function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v !== 'string') return null;
  try {
    const arr = JSON.parse(v) as unknown;
    return Array.isArray(arr) ? arr.map(Number) : null;
  } catch {
    return null;
  }
}
const toVector = (v: readonly number[]) => `[${v.join(',')}]`;

async function embedAll(embed: Embedder, texts: string[]): Promise<{ ok: true; model: string; vectors: number[][] } | { ok: false; detail: string }> {
  const vectors: number[][] = [];
  let model = '';
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = await embed(texts.slice(i, i + BATCH));
    if (!r.ok) return r;
    model = r.model;
    vectors.push(...r.vectors);
  }
  return { ok: true, model, vectors };
}

const hashOf = (texts: string[]) => createHash('sha256').update(JSON.stringify(texts)).digest('hex');

/** The stored niche vector, rebuilt when its texts (or the model) changed. */
export async function ensureNicheVector(
  db: Db,
  channelId: string,
  embed: Embedder,
): Promise<{ ok: true; vector: number[]; model: string; rebuilt: boolean } | { ok: false; detail: string }> {
  const texts = await nicheTexts(db, channelId);
  if (!texts.length) return { ok: false, detail: 'the channel has no niche, premise, series or calendar topics to compare against' };
  const hash = hashOf(texts);
  const { data: stored, error } = await db.from('channel_niche_vectors').select('embedding, model, source_hash').eq('channel_id', channelId).maybeSingle();
  if (error) return { ok: false, detail: `channel_niche_vectors could not be read (${error.message})` };
  const storedVec = stored ? parseVector(stored.embedding) : null;
  // The model is checked on the first new embedding below: a vector from another model is
  // not comparable, so a mismatch rebuilds.
  if (stored && storedVec && stored.source_hash === hash) return { ok: true, vector: storedVec, model: stored.model, rebuilt: false };
  const r = await embedAll(embed, texts);
  if (!r.ok) return { ok: false, detail: `the niche could not be embedded: ${r.detail}` };
  const vector = centroid(r.vectors);
  const row = { channel_id: channelId, model: r.model, embedding: toVector(vector), source_hash: hash, source_count: texts.length, source_texts: texts as unknown as Json, built_at: new Date().toISOString() };
  const { error: wErr } = stored ? await db.from('channel_niche_vectors').update(row).eq('channel_id', channelId) : await db.from('channel_niche_vectors').insert(row);
  if (wErr) return { ok: false, detail: `the niche vector could not be stored (${wErr.message})` };
  return { ok: true, vector, model: r.model, rebuilt: true };
}

/**
 * Score these signal rows for the channel. Embeds only terms with no stored embedding (from
 * this model), then writes `relevance` on each row it could score. Never throws for a vendor
 * or a missing table — the outcome says what was not scored and why.
 */
export async function scoreSignals(
  db: Db,
  channelId: string,
  rows: readonly { id: string; term: string }[],
  embed: Embedder | null | undefined,
  now: number = Date.now(),
): Promise<RelevanceOutcome> {
  const none = (detail: string): RelevanceOutcome => ({ scored: 0, unscored: rows.length, detail, embedded: 0, nicheRebuilt: false });
  if (!rows.length) return { scored: 0, unscored: 0, detail: null, embedded: 0, nicheRebuilt: false };
  if (!embed) return none('relevance not scored: no embedder was given to this run');

  const niche = await ensureNicheVector(db, channelId, embed);
  if (!niche.ok) return none(`relevance not scored: ${niche.detail}`);

  const terms = [...new Set(rows.map((r) => r.term))];
  const known = new Map<string, number[]>();
  for (let i = 0; i < terms.length; i += READ_BATCH) {
    const { data, error } = await db.from('trend_term_embeddings').select('term, model, embedding').in('term', terms.slice(i, i + READ_BATCH));
    if (error) return none(`relevance not scored: trend_term_embeddings could not be read (${error.message})`);
    for (const d of data ?? []) {
      const v = parseVector(d.embedding);
      if (v && d.model === niche.model) known.set(d.term, v);
    }
  }
  const missing = terms.filter((t) => !known.has(t));
  let detail: string | null = null;
  if (missing.length) {
    const r = await embedAll(embed, missing);
    if (!r.ok) {
      detail = `${missing.length} new term${missing.length === 1 ? '' : 's'} not embedded: ${r.detail}`;
    } else if (r.model !== niche.model) {
      detail = `the embedder answered with ${r.model} but the niche vector is ${niche.model}; not comparable, so not scored — the niche is rebuilt on the next run`;
      await db.from('channel_niche_vectors').delete().eq('channel_id', channelId);
    } else {
      for (const [i, t] of missing.entries()) {
        known.set(t, r.vectors[i]);
        await db.from('trend_term_embeddings').upsert({ term: t, model: r.model, embedding: toVector(r.vectors[i]) }, { onConflict: 'term' });
      }
    }
  }

  let scored = 0;
  const at = new Date(now).toISOString();
  for (const row of rows) {
    const v = known.get(row.term);
    if (!v) continue;
    // Rounded to 4 places: the cosine of two vectors from a model is not meaningful past that.
    const relevance = Math.round(cosine(v, niche.vector) * 10_000) / 10_000;
    const { error } = await db.from('trend_signals').update({ relevance, relevance_scored_at: at }).eq('id', row.id);
    if (!error) scored++;
  }
  return { scored, unscored: rows.length - scored, detail, embedded: missing.length && !detail ? missing.length : 0, nicheRebuilt: niche.rebuilt };
}

// ═════════════════════════════════════════════════════════════════════════════
// Stage 2's read: the relevant signals first
// ═════════════════════════════════════════════════════════════════════════════

export interface ConceptSignal {
  source: string;
  term: string;
  region: string | null;
  velocity: number | null;
  volume: number | null;
  /** Null = not scored. */
  relevance: number | null;
}

export interface ConceptSignals {
  signals: ConceptSignal[];
  /** The threshold used, and where it came from. */
  threshold: number;
  /** How the list was chosen, in one sentence — logged by stage 2. */
  basis: string;
}

/** How far back stage 2 looks. A trend older than a fortnight is not one. */
const CONCEPT_WINDOW_DAYS = 14;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  // numeric arrives as a string; Number() here is a decision — small bounded figures.
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * What stage 2 (concepts/run.ts) is shown: this channel's signals at or above its relevance
 * threshold, most relevant first; then — only if there is room — signals that were never
 * scored (NULL), newest first, because "unknown" is not "irrelevant". Signals scored BELOW the
 * threshold are left out: they were measured and found off-niche, which is the point.
 *
 * Without 0051 (no relevance column) or 0046 (no channel column) it falls back to the read
 * stage 2 always made — the newest signals, unfiltered — and says so in `basis`.
 */
export async function signalsForConcepts(db: Db, channelId: string, limit: number, threshold: number, now: number = Date.now()): Promise<ConceptSignals> {
  const since = new Date(now - CONCEPT_WINDOW_DAYS * 86_400_000).toISOString();
  const cols = 'source, term, region, velocity, volume, relevance';
  const map = (r: { source: string; term: string; region: string | null; velocity: unknown; volume: unknown; relevance?: unknown }): ConceptSignal => ({
    source: r.source,
    term: r.term,
    region: r.region,
    velocity: num(r.velocity),
    volume: num(r.volume),
    relevance: num(r.relevance),
  });

  const relevant = await db
    .from('trend_signals')
    .select(cols)
    .eq('channel_id', channelId)
    .gte('captured_at', since)
    .gte('relevance', threshold)
    .order('relevance', { ascending: false })
    .limit(limit);
  if (relevant.error) {
    if (!/does not exist|schema cache|could not find/i.test(relevant.error.message)) throw new Error(`Reading trend_signals: ${relevant.error.message}`);
    const { data } = await db.from('trend_signals').select('source, term, region, velocity, volume').order('captured_at', { ascending: false }).limit(limit);
    return {
      signals: (data ?? []).map((r) => map({ ...r, relevance: null })),
      threshold,
      basis: `newest ${limit} signals, unfiltered — ${relevant.error.message} (relevance needs migration 0051)`,
    };
  }
  const out = (relevant.data ?? []).map(map);
  let unscored = 0;
  if (out.length < limit) {
    const { data, error } = await db
      .from('trend_signals')
      .select(cols)
      .eq('channel_id', channelId)
      .gte('captured_at', since)
      .is('relevance', null)
      .order('captured_at', { ascending: false })
      .limit(limit - out.length);
    if (error) throw new Error(`Reading trend_signals: ${error.message}`);
    unscored = (data ?? []).length;
    out.push(...(data ?? []).map(map));
  }
  return {
    signals: out,
    threshold,
    basis: `${out.length - unscored} at or above relevance ${threshold}, then ${unscored} never scored; below-threshold signals left out (last ${CONCEPT_WINDOW_DAYS} days, this channel only)`,
  };
}
