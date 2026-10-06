import { randomUUID } from 'node:crypto';

import { currentRate } from '../cost/rate-card';
import type { Db } from '../db/server';
import { EMBEDDING_INTEGRATION, EMBEDDING_KEY_FIELD, EMBEDDING_MODEL, embedTexts } from '../drivers/embeddings';
import { resolveCredentials } from '../integrations/credentials';

/**
 * Embeddings for the variation check, with the ledger row written before the call.
 *
 * The vendor returns no usage, so the quantity is ceil(characters / 4) tokens — an estimate
 * of the quantity on top of a rate-card price, and the row says `rate_card` like every
 * estimate. A missing key or an unverified rate is an `ok: false` with the reason; the
 * variation check refuses, naming the reason, rather than passing (0015).
 */

const ENDPOINT = '/v1beta/models:batchEmbedContents';

export type Embedder = (texts: string[]) => Promise<{ ok: true; model: string; vectors: number[][] } | { ok: false; detail: string }>;

export function ledgeredEmbedder(db: Db, channelId: string, usdInrRate: number | null): Embedder {
  return async (texts) => {
    if (texts.length === 0) return { ok: true, model: EMBEDDING_MODEL, vectors: [] };
    if (usdInrRate === null) return { ok: false, detail: 'No USD→INR rate is set, so the call cannot be priced.' };

    const creds = await resolveCredentials(db, EMBEDDING_INTEGRATION).catch(() => null);
    const key = creds?.values[EMBEDDING_KEY_FIELD];
    if (!key) return { ok: false, detail: 'No embeddings key configured (Settings → Integrations).' };

    const rate = await currentRate(db, { driver: EMBEDDING_INTEGRATION, model: EMBEDDING_MODEL, endpoint: ENDPOINT, unit: 'input_token' });
    if (!rate.found) return { ok: false, detail: rate.detail };

    const tokens = texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
    const costUsd = tokens * rate.rate.unitCostUsd;
    const { error } = await db.from('cost_ledger').insert({
      channel_id: channelId,
      driver: EMBEDDING_INTEGRATION,
      stage: '20-embed',
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
