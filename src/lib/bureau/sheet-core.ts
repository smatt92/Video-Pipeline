import type { Readable } from 'node:stream';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { STILL_HEIGHT, STILL_MODEL, STILL_PROVIDER, STILL_RATE_KEY, STILL_WIDTH, type StillOutcome, type StillSubmitted } from '../drivers/still-image';
import type { CredentialRefusal } from '../integrations/verify';
import { fits, headroom } from './caps';

/**
 * One reference-sheet image, through every rule — the part character sheets (decision 0024)
 * and hero-object sheets (0052) share. Generalised out of `generateCharacterSheet` rather than
 * copied, because two copies of the money path are two places for rule 5 to drift.
 *
 *   rate read → cap read → credential → generations row + cost_ledger ESTIMATE before the call
 *   (rules 5 and 6) → submit → wait → measured reconcile when the vendor reports its charge
 *   (never a made-up one) → bytes vendor → worker → bucket (rule 2) → assets row → succeeded.
 *
 * A sheet is a `generations` row with no shot (shot_id null, kind image), told apart by its
 * `request_payload.purpose`; its ledger rows carry the channel, so caps and /costs see it.
 * Replays are the caller's: each caller owns its idempotency key and checks it first.
 */

export interface SheetDeps {
  usdInrRate: number;
  apiKey(): Promise<{ ok: true; value: string } | CredentialRefusal>;
  submit(input: { prompt: string; apiKey: string; seed: number; references?: { uri: string; tag: string }[] }): Promise<StillSubmitted>;
  wait(input: { apiKey: string; taskId: string }): Promise<StillOutcome>;
  fetchBytes(url: string): Promise<Buffer>;
  putBytes(key: string, body: Readable): Promise<number>;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type SheetResult =
  | { ok: true; generationId: string; storageKey: string; costInr: number; prompt: string; reused: boolean }
  | { ok: false; reason: string; spent: boolean };

export function sniffImage(bytes: Buffer): { ext: 'png' | 'jpg' | 'webp' | null; type: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { ext: 'jpg', type: 'image/jpeg' };
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return { ext: null, type: 'application/octet-stream' };
}

export const seedOf = (s: string) => Math.abs([...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 17)) % 2_000_000_000;

export async function makeSheetImage(
  db: Db,
  input: {
    /** The idempotency key of this ONE image (rule 6). The caller has checked it is unused. */
    key: string;
    channelId: string;
    prompt: string;
    payload: Record<string, unknown>;
    /** Ledger stage — '05-sheet' (characters), '05-object-sheet' (hero objects). */
    stage: string;
    /** Where the bytes go, once the generation id and the real extension are known. */
    storageKeyFor(generationId: string, ext: string): string;
    assetMeta: Record<string, unknown>;
    /** The kind of thing, for the sentences a refusal is written in ("sheet", "object sheet"). */
    noun: string;
    /** Tagged reference images (already resolved URLs), for an image drawn FROM a sheet. Absent for a sheet. */
    references?: { uri: string; tag: string }[];
  },
  deps: SheetDeps,
): Promise<SheetResult> {
  const rate = await currentRate(db, { ...STILL_RATE_KEY });
  if (!rate.found) return { ok: false, reason: `unpriced: ${rate.detail}`, spent: false };
  const costUsd = rate.rate.unitCostUsd;
  const costInr = costUsd * deps.usdInrRate;
  const h = await headroom(db, input.channelId, 'short');
  if (!fits(h, costInr)) return { ok: false, reason: `over the spend cap (daily headroom ${h.dailyInr === null ? 'unknown' : `₹${h.dailyInr.toFixed(0)}`})`, spent: false };
  const cred = await deps.apiKey();
  if (!cred.ok) return { ok: false, reason: `${cred.code}: ${cred.reason}`, spent: false };

  // ── The money, before the call (rules 5 and 6) ────────────────────────────
  const { data: gen, error: gErr } = await db
    .from('generations')
    .insert({ shot_id: null, kind: 'image', driver: STILL_PROVIDER, model: STILL_MODEL, attempt: 0, request_payload: input.payload as Json, idempotency_key: input.key, status: 'submitting', origin: 'pipeline' })
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
    idempotency_key: `${input.key}:estimate`,
    stage: input.stage,
  });
  const failGen = async (code: string, detail: string) => {
    await db.from('generations').update({ status: 'failed', error_code: code, error_detail: detail.slice(0, 1000), completed_at: new Date().toISOString() }).eq('id', gen.id);
  };
  if (lErr) {
    await failGen('ledger', lErr.message);
    return { ok: false, reason: `refusing to submit without a ledger row: ${lErr.message}`, spent: false };
  }

  const started = await deps.submit({ prompt: input.prompt, apiKey: cred.value, seed: seedOf(input.key), ...(input.references?.length ? { references: input.references } : {}) });
  if (!started.ok) {
    await failGen(started.code, started.detail);
    return { ok: false, reason: `the vendor refused the ${input.noun}: ${started.code} ${started.detail}`, spent: true };
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
      idempotency_key: `${input.key}:reconcile`,
      stage: input.stage,
    });
    if (error && !/duplicate key|unique/i.test(error.message)) deps.log?.error(`${input.noun} reconcile row not written`, { error: error.message });
  }
  if (done.state === 'failed') {
    await failGen(done.code, done.detail);
    return { ok: false, reason: `the ${input.noun} did not come back: ${done.code} ${done.detail}`, spent: true };
  }

  // ── Bytes: vendor → worker → bucket (rule 2) ─────────────────────────────
  let bytes: Buffer;
  try {
    bytes = await deps.fetchBytes(done.outputUrl);
  } catch (err) {
    await failGen('download', err instanceof Error ? err.message : String(err));
    return { ok: false, reason: `the ${input.noun} could not be downloaded: ${err instanceof Error ? err.message : String(err)}`, spent: true };
  }
  const kind = sniffImage(bytes);
  if (!kind.ext) {
    await failGen('not_an_image', `${bytes.length} bytes that are not png, jpeg or webp`);
    return { ok: false, reason: 'the vendor returned something that is not an image', spent: true };
  }
  const storageKey = input.storageKeyFor(gen.id, kind.ext);
  const { Readable: R } = await import('node:stream');
  const stored = await deps.putBytes(storageKey, R.from(bytes));
  const { error: aErr } = await db
    .from('assets')
    .insert({ kind: 'image', storage_key: storageKey, bytes: stored, width: STILL_WIDTH, height: STILL_HEIGHT, generation_id: gen.id, meta: { ...input.assetMeta, content_type: kind.type } as Json })
    .select('id')
    .single();
  if (aErr) {
    await failGen('asset', aErr.message);
    return { ok: false, reason: `the ${input.noun} was stored but its asset row was not: ${aErr.message}`, spent: true };
  }
  await db.from('generations').update({ status: 'succeeded', confirmed_at: new Date().toISOString(), completed_at: new Date().toISOString() }).eq('id', gen.id);
  return { ok: true, generationId: gen.id, storageKey, costInr, prompt: input.prompt, reused: false };
}
