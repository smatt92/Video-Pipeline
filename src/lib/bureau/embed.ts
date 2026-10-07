import { randomUUID } from 'node:crypto';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import { EMBEDDING_INTEGRATION, EMBEDDING_KEY_FIELD, EMBEDDING_MODEL, embedTexts } from '../drivers/embeddings';
import { verifiedCredential } from '../integrations/verify';

/**
 * Embeddings for the variation check, with the ledger row written before the call.
 *
 * The vendor returns no usage, so the quantity is ceil(characters / 4) tokens — an estimate
 * of the quantity on top of a rate-card price, and the row says `rate_card` like every
 * estimate. A missing or unverified key, or an unverified rate, is an `ok: false` with the reason; the
 * variation check refuses, naming the reason, rather than passing (0015).
 */

const ENDPOINT = '/v1beta/models:batchEmbedContents';

export type Embedder = (texts: string[]) => Promise<{ ok: true; model: string; vectors: number[][] } | { ok: false; detail: string }>;

/** `stage` names who embedded on the ledger: the variation check ('20-embed') or trend relevance ('01-relevance'). */
export function ledgeredEmbedder(db: Db, channelId: string, usdInrRate: number | null, stage: string = '20-embed'): Embedder {
  return async (texts) => {
    if (texts.length === 0) return { ok: true, model: EMBEDDING_MODEL, vectors: [] };
    if (usdInrRate === null) return { ok: false, detail: 'No USD→INR rate is set, so the call cannot be priced.' };

    // Verified, not merely present — the Settings banner's predicate (state.ts). An unverified
    // key is refused here, and the variation check refuses naming this reason (0015).
    const k = await verifiedCredential(db, EMBEDDING_INTEGRATION, EMBEDDING_KEY_FIELD);
    if (!k.ok) return { ok: false, detail: `Embeddings unavailable: ${k.reason}` };
    const key = k.value;

    const rate = await currentRate(db, { driver: EMBEDDING_INTEGRATION, model: EMBEDDING_MODEL, endpoint: ENDPOINT, unit: 'input_token' });
    if (!rate.found) return { ok: false, detail: rate.detail };

    const tokens = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
    const costUsd = tokens * rate.rate.unitCostUsd;
    const { error } = await db.from('cost_ledger').insert({
      channel_id: channelId,
      driver: EMBEDDING_INTEGRATION,
      stage,
      entry_kind: 'estimate',
      unit: 'input_token',
      quantity: tokens,
      cost_usd: costUsd,
      cost_inr: costUsd * usdInrRate,
      usd_inr_rate: usdInrRate,
      idempotency_key: `embed:${randomUUID()}`,
    });
    if (error) return { ok: false, detail: `Refusing to embed: the ledger row could not be written (${error.message}).` };

    return embedTexts(texts, key);
  };
}
