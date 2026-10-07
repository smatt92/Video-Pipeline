import type { Readable } from 'node:stream';

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { currentRate } from '../cost/rate-card';
import type { LlmCostSubject } from '../cost/llm';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import {
  STILL_HEIGHT,
  STILL_INTEGRATION,
  STILL_MODEL,
  STILL_PROMPT_MAX,
  STILL_PROVIDER,
  STILL_RATE_KEY,
  STILL_RATIO,
  STILL_WIDTH,
  type StillOutcome,
  type StillSubmitted,
} from '../drivers/still-image';
import type { CredentialRefusal } from '../integrations/verify';
import { usability } from '../integrations/verify';
import { routed } from '../llm/router';
import { STILL_NEGATIVE, STILL_PROMPT_REF, STILL_SYSTEM, stillUserMessage } from '../prompts/21-still.v1';
import { normaliseOverlay } from '../../remotion/bureau/overlay-scene';
import type { Bible } from './bible';
import { fits, headroom } from './caps';

/**
 * Scene stills (decision 0021): one generated picture per shot, nobody in it.
 *
 * The plan marks every shot that is not a money shot as `still` when stills are available
 * (`stillsAvailability`); this module makes them, one at a time, after the voice stage and
 * before assembly. A still that cannot be made — the rewrite still names the cast, the cap
 * has no room, the vendor refused or timed out — becomes the shot's overlay, and the swap is
 * written to `episodes.qc.plan.swaps`, which is what Cuts already shows for clips.
 *
 * ── Money (rules 5 and 6) ────────────────────────────────────────────────────
 *
 * The `generations` row and a `cost_ledger` estimate (one image × the verified rate) are
 * written BEFORE the vendor is called, keyed `still:<shot>:<attempt>`. A terminal task that
 * reports its charge adds a `measured` reconcile; one that does not adds nothing (CLAUDE.md:
 * never write a measurement you did not take). The spend caps are read before each still,
 * exactly as the dispatcher reads them before each clip.
 *
 * ── The cast stays off-screen ─────────────────────────────────────────────────
 *
 * The shot description is rewritten by the cheapest model tier under a versioned prompt
 * (`prompts/21-still.v1.ts`), then checked by code: any cast name or slug in the rewrite is
 * a refusal (`castNamesIn`). The style and the negative clause are appended here from the
 * bible, never by the model, so no rewrite can drop "no people".
 */

export type StillsAvailability = { available: true } | { available: false; reason: string };

/**
 * Can this channel's shots be planned as stills right now? A probe of the rows, never a
 * constant (CLAUDE.md): the day 0047 is pasted and the integration verifies, it says yes.
 */
export async function stillsAvailability(db: Db, channelId: string): Promise<StillsAvailability> {
  const { data, error } = await db.from('channel_policy').select('stills_enabled').eq('channel_id', channelId).maybeSingle();
  if (error) return { available: false, reason: 'scene stills need migration 0047 (paste the bundle); planned as overlays until then' };
  if (!data) return { available: false, reason: 'the channel has no policy row' };
  if (!data.stills_enabled) return { available: false, reason: 'scene stills are switched off for this channel (channel_policy.stills_enabled)' };
  const use = await usability(db, STILL_INTEGRATION);
  if (!use.usable) return { available: false, reason: `the image integration cannot be used: ${use.reason}` };
  const rate = await currentRate(db, { ...STILL_RATE_KEY });
  if (!rate.found) return { available: false, reason: `stills are unpriced: ${rate.detail}` };
  return { available: true };
}

const TITLES = new Set(['mr', 'mrs', 'ms', 'dr', 'miss', 'the', 'desk', 'head']);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every cast member a text still names — by full name, by any distinctive word of the name
 * ("Iyer" from "Mrs. Iyer"), or by slug. Deterministic, case-insensitive, whole words.
 * The post-check every still prompt passes before money moves.
 */
export function castNamesIn(text: string, cast: readonly { id: string; name: string }[]): string[] {
  const hits: string[] = [];
  for (const c of cast) {
    const words = new Set<string>([c.name, c.id, c.id.replace(/_/g, ' ')]);
    for (const w of c.name.split(/[^A-Za-z']+/)) if (w.length >= 3 && !TITLES.has(w.toLowerCase())) words.add(w);
    const found = [...words].some((w) => w.trim() && new RegExp(`(^|[^A-Za-z])${escape(w.trim())}([^A-Za-z]|$)`, 'i').test(text));
    if (found) hits.push(c.name);
  }
  return hits;
}

/** The bible's look, as one sentence — its own `still_style` when it has one, else from the palette. */
export function stillStyle(world: Bible['world']): string {
  return (
    world.still_style ??
    `Flat line drawing in ${world.palette.chalk} on a ${world.palette.paper} background with faint ${world.palette.grid} grid lines, no shading.`
  );
}

/** Scene + bible style + the lead's accent + the bible's negative prompt + STILL_NEGATIVE. Pure. */
export function composeStillPrompt(input: { scene: string; world: Bible['world']; accent: string }): string {
  const scene = input.scene.trim().replace(/[.\s]+$/, '');
  return `${scene}. ${stillStyle(input.world)} Exactly one element in the accent colour ${input.accent}; everything else chalk on the background. Avoid: ${input.world.negative_prompt}, ${STILL_NEGATIVE}.`;
}

export type StillPrompt = { ok: true; prompt: string; scene: string; model: string | null } | { ok: false; reason: string };

/**
 * The full still prompt for one shot, or why not. The model rewrites; code checks and composes.
 */
export async function stillPromptFor(
  input: { description: string; premise: string; cast: readonly { id: string; name: string }[]; world: Bible['world']; accent: string },
  deps: { db: Db; apiKey: string | null; usdInrRate: number; subject: LlmCostSubject; client?: Pick<Anthropic, 'messages'> },
): Promise<StillPrompt> {
  if (!deps.apiKey) return { ok: false, reason: 'no model key to rewrite the shot without its cast' };
  let scene: string;
  let model: string;
  try {
    const r = await routed(
      { task: 'still_prompt', system: STILL_SYSTEM, user: stillUserMessage({ description: input.description, premise: input.premise, cast: input.cast.map((c) => c.name) }), schema: z.object({ scene: z.string().min(3).max(600) }), maxTokens: 300 },
      { db: deps.db, apiKey: deps.apiKey, usdInrRate: deps.usdInrRate, subject: deps.subject, client: deps.client },
    );
    scene = r.data.scene;
    model = r.model;
  } catch (err) {
    return { ok: false, reason: `the rewrite failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const named = castNamesIn(scene, input.cast);
  if (named.length) return { ok: false, reason: `the rewrite still names ${named.join(', ')} — refused, the cast stays off-screen` };
  const prompt = composeStillPrompt({ scene, world: input.world, accent: input.accent });
  if (prompt.length > STILL_PROMPT_MAX) return { ok: false, reason: `the still prompt is ${prompt.length} characters; the limit is ${STILL_PROMPT_MAX}` };
  return { ok: true, prompt, scene, model };
}

export interface StillDeps {
  usdInrRate: number;
  /** The model key for the rewrite (null → every still falls back, with that reason). */
  llmKey: string | null;
  /** Harness override for the model client. */
  llmClient?: Pick<Anthropic, 'messages'>;
  /** The image integration's key if it has verified, else the refusal by name. */
  apiKey(): Promise<{ ok: true; value: string } | CredentialRefusal>;
  submit(input: { prompt: string; apiKey: string; seed: number }): Promise<StillSubmitted>;
  wait(input: { apiKey: string; taskId: string }): Promise<StillOutcome>;
  /** The finished image's bytes (the vendor's short-lived URL, read once, on the worker). */
  fetchBytes(url: string): Promise<Buffer>;
  putBytes(key: string, body: Readable): Promise<number>;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export interface StillShot {
  id: string;
  idx: number;
  description: string;
  script_id: string;
}

export type StillResult =
  | { ok: true; generationId: string; assetId: string; storageKey: string; costInr: number; prompt: string }
  | { ok: false; reason: string; spent: boolean };

function sniff(bytes: Buffer): { ext: string; type: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { ext: 'jpg', type: 'image/jpeg' };
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return { ext: 'bin', type: 'application/octet-stream' };
}

/**
 * One still for one shot, through every rule: prompt checked, cap read, generation and
 * estimate written before the call, measured reconcile when the vendor says, bytes worker →
 * bucket, an `assets` row. Exported because the one real check (0008) drives it directly.
 */
export async function generateStillForShot(
  db: Db,
  ctx: { shot: StillShot; channelId: string; premise: string; cast: readonly { id: string; name: string }[]; world: Bible['world']; accent: string; kind?: 'short' | 'long_form' },
  deps: StillDeps,
): Promise<StillResult> {
  const { shot } = ctx;
  const { count } = await db.from('generations').select('id', { count: 'exact', head: true }).eq('shot_id', shot.id).eq('kind', 'image');
  const attempt = count ?? 0;
  const key = `still:${shot.id}:${attempt}`;

  const p = await stillPromptFor(
    { description: shot.description, premise: ctx.premise, cast: ctx.cast, world: ctx.world, accent: ctx.accent },
    { db, apiKey: deps.llmKey, usdInrRate: deps.usdInrRate, client: deps.llmClient, subject: { kind: 'channel', channelId: ctx.channelId, idempotencyKey: `${key}:prompt`, stage: '20-still-prompt' } },
  );
  if (!p.ok) return { ok: false, reason: p.reason, spent: false };

  const rate = await currentRate(db, { ...STILL_RATE_KEY });
  if (!rate.found) return { ok: false, reason: `unpriced: ${rate.detail}`, spent: false };
  const costUsd = rate.rate.unitCostUsd;
  const costInr = costUsd * deps.usdInrRate;

  const h = await headroom(db, ctx.channelId, ctx.kind ?? 'short');
  if (!fits(h, costInr)) return { ok: false, reason: `over the spend cap (daily headroom ${h.dailyInr === null ? 'unknown' : `₹${h.dailyInr.toFixed(0)}`})`, spent: false };

  const cred = await deps.apiKey();
  if (!cred.ok) return { ok: false, reason: `${cred.code}: ${cred.reason}`, spent: false };

  // ── The money, before the call ────────────────────────────────────────────
  const { data: gen, error: gErr } = await db
    .from('generations')
    .insert({
      shot_id: shot.id,
      kind: 'image',
      driver: STILL_PROVIDER,
      model: STILL_MODEL,
      attempt,
      request_payload: { prompt: p.prompt, scene: p.scene, prompt_ref: STILL_PROMPT_REF, rewrite_model: p.model, ratio: STILL_RATIO, source_description: shot.description } as Json,
      idempotency_key: key,
      status: 'submitting',
      origin: 'pipeline',
    })
    .select('id')
    .single();
  if (gErr || !gen) return { ok: false, reason: `generation row could not be written: ${gErr?.message}`, spent: false };
  const { error: lErr } = await db.from('cost_ledger').insert({
    generation_id: gen.id,
    driver: STILL_PROVIDER,
    entry_kind: 'estimate',
    cost_source: 'rate_card',
    unit: STILL_RATE_KEY.unit,
    quantity: 1,
    cost_usd: costUsd,
    cost_inr: costInr,
    usd_inr_rate: deps.usdInrRate,
    idempotency_key: `${key}:estimate`,
    stage: '05-still',
  });
  if (lErr) {
    await db.from('generations').update({ status: 'failed', error_code: 'ledger', error_detail: lErr.message }).eq('id', gen.id);
    return { ok: false, reason: `refusing to submit without a ledger row: ${lErr.message}`, spent: false };
  }

  const failGen = async (code: string, detail: string) => {
    await db.from('generations').update({ status: 'failed', error_code: code, error_detail: detail.slice(0, 1000), completed_at: new Date().toISOString() }).eq('id', gen.id);
  };

  const started = await deps.submit({ prompt: p.prompt, apiKey: cred.value, seed: shot.idx + 1 + attempt * 101 });
  if (!started.ok) {
    await failGen(started.code, started.detail);
    return { ok: false, reason: `the vendor refused the still: ${started.code} ${started.detail}`, spent: true };
  }
  await db.from('generations').update({ external_job_id: started.taskId, status: 'queued', submitted_at: new Date().toISOString() }).eq('id', gen.id);

  const done = await deps.wait({ apiKey: cred.value, taskId: started.taskId });
  if (done.charged) {
    const { error } = await db.from('cost_ledger').insert({
      generation_id: gen.id,
      driver: STILL_PROVIDER,
      entry_kind: 'reconcile',
      cost_source: 'measured',
      unit: done.charged.unit,
      quantity: done.charged.quantity,
      cost_usd: done.charged.usd,
      cost_inr: done.charged.usd * deps.usdInrRate,
      usd_inr_rate: deps.usdInrRate,
      idempotency_key: `${key}:reconcile`,
      stage: '05-still',
    });
    if (error && !/duplicate key|unique/i.test(error.message)) deps.log?.error('still reconcile row not written', { error: error.message });
  }
  if (done.state === 'failed') {
    await failGen(done.code, done.detail);
    return { ok: false, reason: `the still did not come back: ${done.code} ${done.detail}`, spent: true };
  }

  // ── Bytes: vendor → worker → bucket (rule 2: never through a Vercel route) ─
  let bytes: Buffer;
  try {
    bytes = await deps.fetchBytes(done.outputUrl);
  } catch (err) {
    await failGen('download', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: `the still could not be downloaded: ${err instanceof Error ? err.message : String(err)}`, spent: true };
  }
  const kind = sniff(bytes);
  if (kind.ext === 'bin') {
    await failGen('not_an_image', `${bytes.length} bytes that are not png, jpeg or webp`);
    return { ok: false, reason: 'the vendor returned something that is not an image', spent: true };
  }
  const storageKey = `stills/${shot.script_id}/${String(shot.idx).padStart(2, '0')}-${attempt}.${kind.ext}`;
  const { Readable: R } = await import('node:stream');
  const stored = await deps.putBytes(storageKey, R.from(bytes));
  const { data: asset, error: aErr } = await db
    .from('assets')
    .insert({ kind: 'image', storage_key: storageKey, bytes: stored, width: STILL_WIDTH, height: STILL_HEIGHT, generation_id: gen.id, meta: { shot_idx: shot.idx, content_type: kind.type, prompt_ref: STILL_PROMPT_REF } as Json })
    .select('id')
    .single();
  if (aErr || !asset) {
    await failGen('asset', aErr?.message ?? 'no asset row');
    return { ok: false, reason: `the still was stored but its asset row was not: ${aErr?.message}`, spent: true };
  }
  await db.from('generations').update({ status: 'succeeded', confirmed_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq('id', gen.id);
  return { ok: true, generationId: gen.id, assetId: asset.id, storageKey, costInr, prompt: p.prompt };
}

/** The newest stored still for a shot, or null. What the assembler draws. */
export async function latestStill(db: Db, shotId: string): Promise<{ storageKey: string; assetId: string } | null> {
  const { data: gens } = await db.from('generations').select('id').eq('shot_id', shotId).eq('kind', 'image').eq('status', 'succeeded').order('completed_at', { ascending: false }).limit(1);
  const g = gens?.[0];
  if (!g) return null;
  const { data: a } = await db.from('assets').select('id, storage_key').eq('generation_id', g.id).eq('kind', 'image').limit(1).maybeSingle();
  return a ? { storageKey: a.storage_key, assetId: a.id } : null;
}

/**
 * A still shot that cannot be drawn becomes its overlay, and says so where Cuts reads it.
 * Idempotent: a second call for the same shot records nothing new.
 */
export async function fallBackToOverlay(db: Db, episodeId: string, shot: { id: string; idx: number }, accent: string, reason: string): Promise<void> {
  const { data: row } = await db.from('shots').select('render_route, overlay_spec').eq('id', shot.id).single();
  if (row?.render_route === 'still') {
    await db
      .from('shots')
      .update({ render_route: 'overlay', overlay_spec: (row.overlay_spec ?? normaliseOverlay({}, accent, shot.idx + 1)) as unknown as Json, status: 'ready' })
      .eq('id', shot.id);
  }
  const { data: e } = await db.from('episodes').select('qc').eq('id', episodeId).single();
  const qc = (e?.qc ?? {}) as { plan?: { swaps?: { idx: number; from: string; reason: string; to?: string }[] } & Record<string, unknown> } & Record<string, unknown>;
  const swaps = qc.plan?.swaps ?? [];
  if (swaps.some((s) => s.idx === shot.idx && s.from === 'still')) return;
  const next = { ...qc, plan: { ...(qc.plan ?? {}), swaps: [...swaps, { idx: shot.idx, from: 'still', to: 'overlay', reason }] } };
  await db.from('episodes').update({ qc: next as unknown as Json, updated_at: new Date().toISOString() }).eq('id', episodeId);
}
