import type { Readable } from 'node:stream';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import {
  STILL_HEIGHT,
  STILL_MODEL,
  STILL_PROMPT_MAX,
  STILL_PROVIDER,
  STILL_RATE_KEY,
  STILL_RATIO,
  STILL_REFERENCE_MAX_BYTES,
  STILL_WIDTH,
  type StillOutcome,
  type StillSubmitted,
} from '../drivers/still-image';
import type { CredentialRefusal } from '../integrations/verify';
import { lockReferenceFrame } from '../channels/bible-admin';
import { SHEET_PROMPT_REF, sheetPrompt } from '../prompts/22-character-sheet.v1';
import { getBible, STORAGE_REF_PREFIX, type ChannelBible } from './bible';
import { fits, headroom } from './caps';
import { requireApprover } from './control';
import { isObjectOnly, lockedSheet, sheetTag } from './picture-cast';
import type { BureauToken } from './tokens';

/**
 * Character sheets — the one canonical cartoon image of each cast member, generated once,
 * looked at and locked by Sahil, and then passed as a tagged reference into every picture of
 * that character (the 'characters' format, decision 0024).
 *
 *   Library → Characters → "Generate sheet" (optional note)
 *     requestCharacterSheet — approver only, authorship_log 'character_sheet_request'
 *     → 27-character-sheet (worker) → generateCharacterSheet: rate, cap, ledger estimate
 *       BEFORE the call (rule 5), key sheet:<channel>:<slug>:<request> (rule 6), bytes
 *       vendor → worker → bucket, an assets row. NOT locked: a sheet is a candidate.
 *   → "Lock" — lockCharacterSheet → bible-admin `lockReferenceFrame`: the candidate's storage
 *     key becomes the character's `reference_frame` (the field `pnpm frame:lock` writes),
 *     authorship_log 'reference_frame_lock', the cast re-synced.
 *
 * Generating and locking are separate on purpose, exactly as `frame:audition` and
 * `frame:lock` are: money is spent producing a candidate, a person chooses, and only the
 * choice becomes part of the bible. Nothing here locks on its own.
 *
 * A sheet is a `generations` row with no shot (shot_id null, kind image), told apart by its
 * `request_payload.purpose = 'character_sheet'`; its ledger rows carry the channel, so the
 * spend caps and /costs see it. No migration.
 */

export const SHEET_PURPOSE = 'character_sheet';
export const SHEET_STAGE = '05-sheet';
/** A sheet in flight longer than this is treated as abandoned, so a new one may be asked for. */
export const SHEET_STALE_MS = 15 * 60_000;

export interface SheetDeps {
  usdInrRate: number;
  apiKey(): Promise<{ ok: true; value: string } | CredentialRefusal>;
  submit(input: { prompt: string; apiKey: string; seed: number }): Promise<StillSubmitted>;
  wait(input: { apiKey: string; taskId: string }): Promise<StillOutcome>;
  fetchBytes(url: string): Promise<Buffer>;
  putBytes(key: string, body: Readable): Promise<number>;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type SheetResult =
  | { ok: true; generationId: string; storageKey: string; costInr: number; prompt: string; reused: boolean }
  | { ok: false; reason: string; spent: boolean };

interface SheetPayload {
  purpose: typeof SHEET_PURPOSE;
  channel_id: string;
  character: string;
  request_id: string;
  note: string | null;
  prompt: string;
  prompt_ref: string;
  ratio: string;
}

function isSheetPayload(p: unknown): p is SheetPayload {
  return !!p && typeof p === 'object' && (p as Record<string, unknown>).purpose === SHEET_PURPOSE;
}

function sniff(bytes: Buffer): { ext: 'png' | 'jpg' | 'webp' | null; type: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { ext: 'jpg', type: 'image/jpeg' };
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return { ext: null, type: 'application/octet-stream' };
}

const seedOf = (s: string) => Math.abs([...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 17)) % 2_000_000_000;

/** The sheet prompt for a character of a channel's bible, or why not. Pure. */
export function sheetPromptFor(cb: Pick<ChannelBible, 'bible'>, slug: string, note?: string | null) {
  const c = cb.bible.characters.find((x) => x.id === slug);
  if (!c) return { ok: false as const, reason: `No character "${slug}" in this channel's cast.` };
  return sheetPrompt(c, cb.bible.world, note ?? undefined, STILL_PROMPT_MAX);
}

/**
 * One character sheet, through every rule: prompt from the bible, rate and cap read, the
 * generation and its estimate written before the call, a measured reconcile when the vendor
 * reports its charge, bytes worker → bucket, an assets row. Replayable: the same request id
 * returns the sheet it already made and never pays twice.
 */
export async function generateCharacterSheet(db: Db, input: { channelId: string; slug: string; note?: string | null; requestId: string }, deps: SheetDeps): Promise<SheetResult> {
  const key = `sheet:${input.channelId}:${input.slug}:${input.requestId}`;
  const { data: prior } = await db.from('generations').select('id, status, error_detail').eq('idempotency_key', key).maybeSingle();
  if (prior) {
    if (prior.status !== 'succeeded') return { ok: false, reason: `this request already ran and ended ${prior.status}${prior.error_detail ? `: ${prior.error_detail}` : ''} — ask for a new sheet`, spent: false };
    const { data: a } = await db.from('assets').select('storage_key').eq('generation_id', prior.id).maybeSingle();
    if (!a) return { ok: false, reason: 'this request made a sheet whose asset row is missing', spent: false };
    return { ok: true, generationId: prior.id, storageKey: a.storage_key, costInr: 0, prompt: '', reused: true };
  }

  const cb = await getBible(db, input.channelId);
  const c = cb.characterBySlug(input.slug);
  if (!c) return { ok: false, reason: `No character "${input.slug}" in the ${cb.slug} cast.`, spent: false };
  const note = input.note?.trim() ? input.note.trim().replace(/\s+/g, ' ').slice(0, 200) : null;
  const p = sheetPrompt(c, cb.bible.world, note ?? undefined, STILL_PROMPT_MAX);
  if (!p.ok) return { ok: false, reason: p.reason, spent: false };

  const rate = await currentRate(db, { ...STILL_RATE_KEY });
  if (!rate.found) return { ok: false, reason: `unpriced: ${rate.detail}`, spent: false };
  const costUsd = rate.rate.unitCostUsd;
  const costInr = costUsd * deps.usdInrRate;
  const h = await headroom(db, input.channelId, 'short');
  if (!fits(h, costInr)) return { ok: false, reason: `over the spend cap (daily headroom ${h.dailyInr === null ? 'unknown' : `₹${h.dailyInr.toFixed(0)}`})`, spent: false };
  const cred = await deps.apiKey();
  if (!cred.ok) return { ok: false, reason: `${cred.code}: ${cred.reason}`, spent: false };

  // ── The money, before the call (rules 5 and 6) ────────────────────────────
  const payload: SheetPayload = { purpose: SHEET_PURPOSE, channel_id: input.channelId, character: c.id, request_id: input.requestId, note, prompt: p.prompt, prompt_ref: SHEET_PROMPT_REF, ratio: STILL_RATIO };
  const { data: gen, error: gErr } = await db
    .from('generations')
    .insert({ shot_id: null, kind: 'image', driver: STILL_PROVIDER, model: STILL_MODEL, attempt: 0, request_payload: payload as unknown as Json, idempotency_key: key, status: 'submitting', origin: 'pipeline' })
    .select('id')
    .single();
  if (gErr || !gen) return { ok: false, reason: `generation row could not be written: ${gErr?.message}`, spent: false };
  const { error: lErr } = await db.from('cost_ledger').insert({
    generation_id: gen.id,
    channel_id: input.channelId,
    driver: STILL_PROVIDER,
    entry_kind: 'estimate',
    cost_source: 'rate_card',
    unit: STILL_RATE_KEY.unit,
    quantity: 1,
    cost_usd: costUsd,
    cost_inr: costInr,
    usd_inr_rate: deps.usdInrRate,
    idempotency_key: `${key}:estimate`,
    stage: SHEET_STAGE,
  });
  const failGen = async (code: string, detail: string) => {
    await db.from('generations').update({ status: 'failed', error_code: code, error_detail: detail.slice(0, 1000), completed_at: new Date().toISOString() }).eq('id', gen.id);
  };
  if (lErr) {
    await failGen('ledger', lErr.message);
    return { ok: false, reason: `refusing to submit without a ledger row: ${lErr.message}`, spent: false };
  }

  const started = await deps.submit({ prompt: p.prompt, apiKey: cred.value, seed: seedOf(key) });
  if (!started.ok) {
    await failGen(started.code, started.detail);
    return { ok: false, reason: `the vendor refused the sheet: ${started.code} ${started.detail}`, spent: true };
  }
  await db.from('generations').update({ external_job_id: started.taskId, status: 'queued', submitted_at: new Date().toISOString() }).eq('id', gen.id);

  const done = await deps.wait({ apiKey: cred.value, taskId: started.taskId });
  if (done.charged) {
    const { error } = await db.from('cost_ledger').insert({
      generation_id: gen.id,
      channel_id: input.channelId,
      driver: STILL_PROVIDER,
      entry_kind: 'reconcile',
      cost_source: 'measured',
      unit: done.charged.unit,
      quantity: done.charged.quantity,
      cost_usd: done.charged.usd,
      cost_inr: done.charged.usd * deps.usdInrRate,
      usd_inr_rate: deps.usdInrRate,
      idempotency_key: `${key}:reconcile`,
      stage: SHEET_STAGE,
    });
    if (error && !/duplicate key|unique/i.test(error.message)) deps.log?.error('sheet reconcile row not written', { error: error.message });
  }
  if (done.state === 'failed') {
    await failGen(done.code, done.detail);
    return { ok: false, reason: `the sheet did not come back: ${done.code} ${done.detail}`, spent: true };
  }

  // ── Bytes: vendor → worker → bucket (rule 2) ─────────────────────────────
  let bytes: Buffer;
  try {
    bytes = await deps.fetchBytes(done.outputUrl);
  } catch (err) {
    await failGen('download', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: `the sheet could not be downloaded: ${err instanceof Error ? err.message : String(err)}`, spent: true };
  }
  const kind = sniff(bytes);
  if (!kind.ext) {
    await failGen('not_an_image', `${bytes.length} bytes that are not png, jpeg or webp`);
    return { ok: false, reason: 'the vendor returned something that is not an image', spent: true };
  }
  const storageKey = `characters/${c.id}/sheet-${gen.id.slice(0, 8)}.${kind.ext}`;
  const { Readable: R } = await import('node:stream');
  const stored = await deps.putBytes(storageKey, R.from(bytes));
  const { error: aErr } = await db
    .from('assets')
    .insert({ kind: 'image', storage_key: storageKey, bytes: stored, width: STILL_WIDTH, height: STILL_HEIGHT, generation_id: gen.id, meta: { purpose: SHEET_PURPOSE, character: c.id, content_type: kind.type, prompt_ref: SHEET_PROMPT_REF } as Json })
    .select('id')
    .single();
  if (aErr) {
    await failGen('asset', aErr.message);
    return { ok: false, reason: `the sheet was stored but its asset row was not: ${aErr.message}`, spent: true };
  }
  await db.from('generations').update({ status: 'succeeded', confirmed_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq('id', gen.id);
  deps.log?.info('sheet made', { character: c.id, storageKey });
  return { ok: true, generationId: gen.id, storageKey, costInr, prompt: p.prompt, reused: false };
}

export interface SheetRow {
  generationId: string;
  character: string;
  status: string;
  note: string | null;
  submittedAt: string;
  reason: string | null;
  storageKey: string | null;
  bytes: number | null;
}

/** Every sheet generation of a channel, newest first, with its stored image when there is one. */
export async function sheetsOf(db: Db, channelId: string): Promise<SheetRow[]> {
  const { data: gens } = await db
    .from('generations')
    .select('id, status, request_payload, submitted_at, error_detail')
    .is('shot_id', null)
    .eq('kind', 'image')
    .order('submitted_at', { ascending: false })
    .limit(500);
  const mine = (gens ?? []).filter((g) => isSheetPayload(g.request_payload) && g.request_payload.channel_id === channelId);
  if (!mine.length) return [];
  const { data: assets } = await db.from('assets').select('generation_id, storage_key, bytes').in('generation_id', mine.map((g) => g.id));
  return mine.map((g) => {
    const p = g.request_payload as unknown as SheetPayload;
    const a = (assets ?? []).find((x) => x.generation_id === g.id);
    return { generationId: g.id, character: p.character, status: g.status, note: p.note, submittedAt: g.submitted_at, reason: g.error_detail, storageKey: a?.storage_key ?? null, bytes: a?.bytes === null || a?.bytes === undefined ? null : Number(a.bytes) };
  });
}

const inFlight = (r: SheetRow, now: number) => ['submitting', 'queued', 'running'].includes(r.status) && now - Date.parse(r.submittedAt) < SHEET_STALE_MS;

export interface SheetEffects {
  /** Start `27-character-sheet`; returns the run id. */
  startSheet?(input: { channelId: string; slug: string; note: string | null; requestId: string }): Promise<string | null>;
}

/** Characters → "Generate sheet": approver only, logged, one in flight per character, then the worker. */
export async function requestCharacterSheet(db: Db, token: BureauToken, effects: SheetEffects, input: { slug: string; note?: string | null }) {
  requireApprover(token, 'generate a character sheet');
  const cb = await getBible(db, token.channelId);
  const c = cb.characterBySlug(input.slug);
  if (!c) throw new Error(`No character "${input.slug}" in the ${cb.slug} cast.`);
  const p = sheetPromptFor(cb, c.id, input.note);
  if (!p.ok) throw new Error(p.reason);
  const busy = (await sheetsOf(db, token.channelId)).find((r) => r.character === c.id && inFlight(r, Date.now()));
  if (busy) throw new Error(`A sheet for ${c.name} is already being drawn. One at a time — refresh in a minute.`);
  if (!effects.startSheet) throw new Error('This deployment cannot start a sheet (no Trigger.dev secret key).');
  const note = input.note?.trim() ? input.note.trim().replace(/\s+/g, ' ').slice(0, 200) : null;
  const { randomUUID } = await import('node:crypto');
  const requestId = randomUUID();
  await db.from('authorship_log').insert({
    channel_id: token.channelId,
    actor_scope: token.scope,
    token_id: token.id,
    profile_id: token.profileId,
    action: 'character_sheet_request',
    subject_type: 'character',
    subject_id: c.id,
    exact_text: note,
    payload: { request_id: requestId, prompt_ref: SHEET_PROMPT_REF } as Json,
  });
  const runId = await effects.startSheet({ channelId: token.channelId, slug: c.id, note, requestId });
  return { ok: true as const, requestId, runId, name: c.name };
}

/** Characters → "Lock": the candidate becomes the character's reference frame. Approver only. */
export async function lockCharacterSheet(db: Db, token: BureauToken, input: { slug: string; generationId: string }) {
  requireApprover(token, 'lock a character sheet');
  const row = (await sheetsOf(db, token.channelId)).find((r) => r.generationId === input.generationId);
  if (!row) throw new Error('No such sheet on this channel.');
  if (row.character !== input.slug) throw new Error(`That sheet is ${row.character}'s, not ${input.slug}'s.`);
  if (row.status !== 'succeeded' || !row.storageKey) throw new Error(`That sheet ${row.status === 'succeeded' ? 'has no stored image' : `is ${row.status}`}; only a finished sheet can be locked.`);
  if (row.bytes !== null && row.bytes > STILL_REFERENCE_MAX_BYTES) throw new Error(`That sheet is ${(row.bytes / 1048576).toFixed(1)} MB; the image model takes references up to 5 MB.`);
  const r = await lockReferenceFrame(db, { scope: token.scope === 'approver' ? 'approver' : 'agent', profileId: token.profileId, via: 'ui:characters' }, token.channelId, {
    characterSlug: input.slug,
    ref: `${STORAGE_REF_PREFIX}${row.storageKey}`,
    source: { generation_id: row.generationId, token_id: token.id },
  });
  if (!r.ok) throw new Error(r.refused);
  return r;
}

export interface CharacterCard {
  slug: string;
  name: string;
  role: string;
  accent: string;
  tag: string;
  objectOnly: boolean;
  /** The locked reference, or null (a placeholder is null). */
  locked: string | null;
  /** The locked reference's storage key when it is one of ours — what the screen presigns. */
  lockedKey: string | null;
  sheets: SheetRow[];
  inFlight: boolean;
}

/** The Characters screen: each character's locked sheet, its recent candidates, and the one-time price. */
export async function charactersScreen(db: Db, channelId: string, cb: ChannelBible, deps: { usdInrRate: number | null }) {
  const sheets = await sheetsOf(db, channelId);
  const now = Date.now();
  const cards: CharacterCard[] = cb.bible.characters.map((c) => {
    const locked = lockedSheet(c);
    const mine = sheets.filter((s) => s.character === c.id);
    return {
      slug: c.id,
      name: c.name,
      role: c.role,
      accent: c.accent_hex,
      tag: sheetTag(c),
      objectOnly: isObjectOnly(c),
      locked,
      lockedKey: locked?.startsWith(STORAGE_REF_PREFIX) ? locked.slice(STORAGE_REF_PREFIX.length) : null,
      sheets: mine.slice(0, 4),
      inFlight: mine.some((s) => inFlight(s, now)),
    };
  });
  const rate = await currentRate(db, { ...STILL_RATE_KEY });
  const sheetInr = rate.found && deps.usdInrRate !== null ? rate.rate.unitCostUsd * deps.usdInrRate : null;
  const sheetNote = !rate.found ? `unpriced: ${rate.detail}` : deps.usdInrRate === null ? 'no USD→INR rate is set' : null;
  const { data: dbBible } = await db.from('channel_bibles').select('channel_id').eq('channel_id', channelId).maybeSingle();
  return { cards, sheetInr, sheetNote, canLock: !!dbBible };
}
