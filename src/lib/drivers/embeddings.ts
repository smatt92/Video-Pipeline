import { z } from 'zod';

import { httpJson } from './http';

/**
 * Text embeddings for the variation check (script and title similarity).
 *
 * Dimension is fixed at 768 because the `briefs` vector columns are, and a model that
 * answered at another width would fail the insert rather than compare garbage. The model
 * is named in one place so a swap is one line plus a re-embed, not a schema change.
 *
 * Unverified against a live key — 0008 §B1.
 *
 * ── Free tier, so 429 is normal ──────────────────────────────────────────────
 *
 * Since 0015 this key is a free-tier key used for nothing else, and the free tier answers
 * 429 / RESOURCE_EXHAUSTED under ordinary use. A 429 is retried with backoff (Retry-After
 * honoured, else 2 s doubling, at most `EMBED_ATTEMPTS` calls) before it is reported. What it
 * is reported AS matters more than the retry: an `ok: false` with the reason, which the
 * variation check turns into a refusal naming it — never a pass, never a similarity of 0.
 */

/** Calls per batch before a rate limit is reported as unavailable. */
export const EMBED_ATTEMPTS = 4;

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;
/** Integration whose key this needs. */
export const EMBEDDING_INTEGRATION = 'gemini';
export const EMBEDDING_KEY_FIELD = 'GEMINI_API_KEY';

const Batch = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
});

export type EmbedResult =
  | { ok: true; model: string; vectors: number[][] }
  | { ok: false; detail: string };

export async function embedTexts(
  texts: string[],
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<EmbedResult> {
  if (!apiKey) return { ok: false, detail: 'No embeddings key configured.' };
  if (texts.length === 0) return { ok: true, model: EMBEDDING_MODEL, vectors: [] };

  let res: Awaited<ReturnType<typeof httpJson>> | null = null;
  for (let attempt = 1; attempt <= EMBED_ATTEMPTS; attempt++) {
    res = await embedOnce(texts, apiKey, fetchImpl);
    if (res.ok || res.code !== 'rate_limited') break;
    if (attempt === EMBED_ATTEMPTS) {
      return { ok: false, detail: `embeddings vendor rate-limited (429) on all ${EMBED_ATTEMPTS} attempts: ${res.detail}` };
    }
    await sleep(Math.min((res.retryAfterS ?? 2 ** attempt) * 1000, 30_000));
  }
  if (!res!.ok) return { ok: false, detail: `${res!.code}: ${res!.detail}` };

  const parsed = Batch.safeParse(res!.json);
  if (!parsed.success) return { ok: false, detail: 'Embedding response did not match the documented shape.' };
  const vectors = parsed.data.embeddings.map((e) => e.values);
  if (vectors.length !== texts.length) return { ok: false, detail: `Asked for ${texts.length} embeddings, got ${vectors.length}.` };
  if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    return { ok: false, detail: `Embedding width was not ${EMBEDDING_DIMENSIONS}.` };
  }
  return { ok: true, model: EMBEDDING_MODEL, vectors };
}

function embedOnce(texts: string[], apiKey: string, fetchImpl: typeof fetch) {
  return httpJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          taskType: 'SEMANTIC_SIMILARITY',
          outputDimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
      fetchImpl,
      timeoutMs: 20_000,
    },
  );
}
