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
 */

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;
/** Integration whose key this needs. */
export const EMBEDDING_INTEGRATION = 'gemini';

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
): Promise<EmbedResult> {
  if (!apiKey) return { ok: false, detail: 'No embeddings key configured.' };
  if (texts.length === 0) return { ok: true, model: EMBEDDING_MODEL, vectors: [] };

  const res = await httpJson(
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
  if (!res.ok) return { ok: false, detail: `${res.code}: ${res.detail}` };

  const parsed = Batch.safeParse(res.json);
  if (!parsed.success) return { ok: false, detail: 'Embedding response did not match the documented shape.' };
  const vectors = parsed.data.embeddings.map((e) => e.values);
  if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    return { ok: false, detail: `Embedding width was not ${EMBEDDING_DIMENSIONS}.` };
  }
  return { ok: true, model: EMBEDDING_MODEL, vectors };
}
