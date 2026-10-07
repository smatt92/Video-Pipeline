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
import { STILL_NEGATIVE, STILL_PROMPT_REF, STILL_SYSTEM, stillUserMessage } from '../prompts/21-still.v4';
import { STILL_CAST_PROMPT_REF, STILL_CAST_SYSTEM, stillCastNegative, stillCastUserMessage } from '../prompts/21-still.v5';
import { normaliseOverlay } from '../../remotion/bureau/overlay-scene';
import type { Bible } from './bible';
import { fits, headroom } from './caps';
import type { PictureCast, PictureRef } from './picture-cast';

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
 * (`prompts/21-still.v4.ts`), then checked by code: any cast name or slug in the rewrite is
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
  return `${scene}. ${stillStyle(input.world)} Use ${input.accent} as the highlight colour on the single most important element. Avoid: ${input.world.negative_prompt}, ${STILL_NEGATIVE}.`;
}

/**
 * The character clause of a 'characters' picture, written by code from the bible so no rewrite
 * can drop a tag or a prop. `detail` false is the compact form, used only when the full one
 * would not fit the vendor's prompt limit.
 */
export function castClause(refs: readonly PictureRef[], detail = true): string {
  const people = refs.filter((r) => !r.objectOnly);
  const objects = refs.filter((r) => r.objectOnly);
  const parts: string[] = [];
  if (people.length) {
    const each = people.map((r) => {
      const where = r.foreground ? 'in front' : 'smaller, beside or behind';
      return detail ? `@${r.tag} ${where} (${[r.figure, r.silhouette, ...r.props].filter(Boolean).join('; ')}; accent ${r.accent})` : `@${r.tag} ${where}${r.figure ? ` (${r.figure})` : ''}`;
    });
    parts.push(`Characters drawn exactly as in their reference images: ${each.join(', ')}.`);
  }
  for (const r of objects) parts.push(`@${r.tag} is only the object in its reference image${detail && r.props.length ? ` (${r.props.join('; ')})` : ''} — never a body, arms, hands or a face.`);
  return parts.join(' ');
}

/** Scene + the character clause + bible style + accent + negatives, for a picture with the cast in it. Pure. */
export function composeCharacterStillPrompt(input: { scene: string; world: Bible['world']; accent: string; refs: readonly PictureRef[]; detail?: boolean }): string {
  const scene = input.scene.trim().replace(/[.\s]+$/, '');
  return `${scene}. ${castClause(input.refs, input.detail ?? true)} ${stillStyle(input.world)} Use ${input.accent} as the highlight colour on the single most important element. Avoid: ${input.world.negative_prompt}, ${stillCastNegative(input.refs.map((r) => r.tag))}.`;
}

/** The text with every `@Tag` of the referenced characters removed — what the cast-name check reads. */
export function withoutTags(text: string, refs: readonly PictureRef[]): string {
  let out = text;
  for (const r of refs) out = out.replace(new RegExp(`@${escape(r.tag)}(?![A-Za-z0-9_])`, 'g'), ' ');
  return out;
}

export type StillPrompt = { ok: true; prompt: string; scene: string; model: string | null; promptRef: string } | { ok: false; reason: string };

/**
 * The full still prompt for one shot, or why not. The model rewrites; code checks and composes.
 */
export async function stillPromptFor(
  input: { description: string; premise: string; cast: readonly { id: string; name: string }[]; world: Bible['world']; accent: string; narration?: string; part?: { index: number; of: number }; direction?: string; refs?: readonly PictureRef[] },
  deps: { db: Db; apiKey: string | null; usdInrRate: number; subject: LlmCostSubject; client?: Pick<Anthropic, 'messages'> },
): Promise<StillPrompt> {
  if (!deps.apiKey) return { ok: false, reason: 'no model key to rewrite the shot without its cast' };
  const refs = input.refs ?? [];
  const withCast = refs.length > 0;
  let scene: string;
  let model: string;
  try {
    const user = withCast
      ? stillCastUserMessage({ description: input.description, premise: input.premise, cast: input.cast.map((c) => c.name), characters: refs.map((r) => ({ tag: r.tag, foreground: r.foreground, objectOnly: r.objectOnly, role: r.role })), narration: input.narration, part: input.part, direction: input.direction })
      : stillUserMessage({ description: input.description, premise: input.premise, cast: input.cast.map((c) => c.name), narration: input.narration, part: input.part, direction: input.direction });
    const r = await routed(
      { task: 'still_prompt', system: withCast ? STILL_CAST_SYSTEM : STILL_SYSTEM, user, schema: z.object({ scene: z.string().min(3).max(600) }), maxTokens: 300 },
      { db: deps.db, apiKey: deps.apiKey, usdInrRate: deps.usdInrRate, subject: deps.subject, client: deps.client },
    );
    scene = r.data.scene;
    model = r.model;
  } catch (err) {
    return { ok: false, reason: `the rewrite failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Only the characters referenced in THIS picture may appear, and only through their tags.
  // Everyone else in the cast is refused by any form of their name, exactly as before.
  const referenced = new Set(refs.map((r) => r.slug));
  const named = castNamesIn(withoutTags(scene, refs), input.cast.filter((c) => !referenced.has(c.id)));
  if (named.length) return { ok: false, reason: withCast ? `the rewrite names ${named.join(', ')}, who is not referenced in this picture — refused, nobody is drawn without their sheet` : `the rewrite still names ${named.join(', ')} — refused, the cast stays off-screen` };
  if (!withCast) {
    const prompt = composeStillPrompt({ scene, world: input.world, accent: input.accent });
    if (prompt.length > STILL_PROMPT_MAX) return { ok: false, reason: `the still prompt is ${prompt.length} characters; the limit is ${STILL_PROMPT_MAX}` };
    return { ok: true, prompt, scene, model, promptRef: STILL_PROMPT_REF };
  }
  const full = composeCharacterStillPrompt({ scene, world: input.world, accent: input.accent, refs });
  const prompt = full.length <= STILL_PROMPT_MAX ? full : composeCharacterStillPrompt({ scene, world: input.world, accent: input.accent, refs, detail: false });
  if (prompt.length > STILL_PROMPT_MAX) return { ok: false, reason: `the still prompt is ${prompt.length} characters even with the short character clause; the limit is ${STILL_PROMPT_MAX}` };
  return { ok: true, prompt, scene, model, promptRef: STILL_CAST_PROMPT_REF };
}

export interface StillDeps {
  usdInrRate: number;
  /** The model key for the rewrite (null → every still falls back, with that reason). */
  llmKey: string | null;
  /** Harness override for the model client. */
  llmClient?: Pick<Anthropic, 'messages'>;
  /** The image integration's key if it has verified, else the refusal by name. */
  apiKey(): Promise<{ ok: true; value: string } | CredentialRefusal>;
  submit(input: { prompt: string; apiKey: string; seed: number; references?: { uri: string; tag: string }[] }): Promise<StillSubmitted>;
  wait(input: { apiKey: string; taskId: string }): Promise<StillOutcome>;
  /** The finished image's bytes (the vendor's short-lived URL, read once, on the worker). */
  fetchBytes(url: string): Promise<Buffer>;
  putBytes(key: string, body: Readable): Promise<number>;
  /**
   * A locked sheet (`storage:<key>` or https) as a URL the image model can fetch, minted at
   * submit and never stored. Absent → this caller cannot put the cast in a picture, and a
   * 'characters' picture is drawn with nobody in it, saying so.
   */
  resolveRef?(ref: string): Promise<string>;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export interface StillShot {
  id: string;
  idx: number;
  description: string;
  script_id: string;
}

export type StillResult =
  | { ok: true; generationId: string; assetId: string; storageKey: string; costInr: number; prompt: string; drawn: string[]; excluded: { slug: string; reason: string }[] }
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
  ctx: {
    shot: StillShot;
    channelId: string;
    premise: string;
    cast: readonly { id: string; name: string }[];
    world: Bible['world'];
    accent: string;
    kind?: 'short' | 'long_form';
    /** Which of the shot's pictures this is (formats.ts), and the narration under it. Absent → the shot's only picture. */
    part?: { index: number; of: number; narration: string };
    /** The approver's note on a redraw (Cuts → Redraw, redraw.ts): reaches the rewrite as a direction. */
    direction?: string;
    /** 'characters' format: who is drawn in this picture from their locked sheets, and who was left out (picture-cast.ts). */
    pictureCast?: PictureCast;
  },
  deps: StillDeps,
): Promise<StillResult> {
  const { shot } = ctx;
  // Who is in the picture. A caller that cannot mint a URL for a sheet draws nobody — never a
  // character without its sheet — and the reason is recorded with the rest of the exclusions.
  let refs = ctx.pictureCast?.refs ?? [];
  const excluded = [...(ctx.pictureCast?.excluded ?? [])];
  if (refs.length && !deps.resolveRef) {
    excluded.push(...refs.map((r) => ({ slug: r.slug, reason: 'this run cannot read character sheets — drawn with nobody in it' })));
    refs = [];
  }
  const part = ctx.part?.index ?? 0;
  // Attempts count per picture: a shot's second picture starts at attempt 0 too.
  const { data: prior } = await db.from('generations').select('request_payload').eq('shot_id', shot.id).eq('kind', 'image');
  const attempt = (prior ?? []).filter((g) => partOf(g.request_payload) === part).length;
  // Part 0 keeps the pre-v3 key shape, so a shot's first picture dedupes against stills made before parts existed.
  const key = part === 0 ? `still:${shot.id}:${attempt}` : `still:${shot.id}:p${part}:${attempt}`;

  const p = await stillPromptFor(
    { description: shot.description, premise: ctx.premise, cast: ctx.cast, world: ctx.world, accent: refs[0]?.accent ?? ctx.accent, narration: ctx.part?.narration || undefined, part: ctx.part ? { index: ctx.part.index, of: ctx.part.of } : undefined, direction: ctx.direction, refs },
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

  // Every sheet is minted a URL before any money moves: a sheet that cannot be read refuses
  // the picture here, unpaid, rather than reaching the vendor without it.
  let references: { uri: string; tag: string }[] = [];
  try {
    references = await Promise.all(refs.map(async (r) => ({ uri: await deps.resolveRef!(r.ref), tag: r.tag })));
  } catch (err) {
    return { ok: false, reason: `a character sheet could not be read: ${err instanceof Error ? err.message : String(err)}`, spent: false };
  }

  // ── The money, before the call ────────────────────────────────────────────
  const { data: gen, error: gErr } = await db
    .from('generations')
    .insert({
      shot_id: shot.id,
      kind: 'image',
      driver: STILL_PROVIDER,
      model: STILL_MODEL,
      attempt,
      request_payload: { prompt: p.prompt, scene: p.scene, prompt_ref: p.promptRef, rewrite_model: p.model, cast: refs.map((r) => ({ slug: r.slug, tag: r.tag, ref: r.ref, foreground: r.foreground })), cast_excluded: excluded, ratio: STILL_RATIO, source_description: shot.description, part, parts: ctx.part?.of ?? 1, narration: ctx.part?.narration ?? null, direction: ctx.direction ?? null } as Json,
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

  const started = await deps.submit({ prompt: p.prompt, apiKey: cred.value, seed: shot.idx + 1 + attempt * 101 + part * 7, ...(references.length ? { references } : {}) });
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
  const storageKey = part === 0 ? `stills/${shot.script_id}/${String(shot.idx).padStart(2, '0')}-${attempt}.${kind.ext}` : `stills/${shot.script_id}/${String(shot.idx).padStart(2, '0')}-p${part}-${attempt}.${kind.ext}`;
  const { Readable: R } = await import('node:stream');
  const stored = await deps.putBytes(storageKey, R.from(bytes));
  const { data: asset, error: aErr } = await db
    .from('assets')
    .insert({ kind: 'image', storage_key: storageKey, bytes: stored, width: STILL_WIDTH, height: STILL_HEIGHT, generation_id: gen.id, meta: { shot_idx: shot.idx, part, content_type: kind.type, prompt_ref: p.promptRef, cast: refs.map((r) => r.slug) } as Json })
    .select('id')
    .single();
  if (aErr || !asset) {
    await failGen('asset', aErr?.message ?? 'no asset row');
    return { ok: false, reason: `the still was stored but its asset row was not: ${aErr?.message}`, spent: true };
  }
  await db.from('generations').update({ status: 'succeeded', confirmed_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq('id', gen.id);
  return { ok: true, generationId: gen.id, assetId: asset.id, storageKey, costInr, prompt: p.prompt, drawn: refs.map((r) => r.slug), excluded };
}

/** Which picture of its shot a still generation is (legacy rows, made before parts, are picture 0). */
export function partOf(payload: unknown): number {
  const v = payload && typeof payload === 'object' ? (payload as Record<string, unknown>).part : undefined;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * The newest stored picture for each part of a shot. What the stills step skips and the
 * assembler draws. An empty map means the shot has no picture at all.
 */
export async function stillsByPart(db: Db, shotId: string): Promise<Map<number, { storageKey: string; assetId: string }>> {
  const { data: gens } = await db
    .from('generations')
    .select('id, request_payload, completed_at')
    .eq('shot_id', shotId)
    .eq('kind', 'image')
    .eq('status', 'succeeded')
    .order('completed_at', { ascending: false });
  const newest = new Map<number, string>();
  for (const g of gens ?? []) {
    const k = partOf(g.request_payload);
    if (!newest.has(k)) newest.set(k, g.id);
  }
  const out = new Map<number, { storageKey: string; assetId: string }>();
  if (!newest.size) return out;
  const { data: assets } = await db.from('assets').select('id, storage_key, generation_id').in('generation_id', [...newest.values()]).eq('kind', 'image');
  for (const [k, genId] of newest) {
    const a = (assets ?? []).find((x) => x.generation_id === genId);
    if (a) out.set(k, { storageKey: a.storage_key, assetId: a.id });
  }
  return out;
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
