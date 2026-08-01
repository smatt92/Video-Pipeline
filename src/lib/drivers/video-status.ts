import { z } from 'zod';

import { env } from '../env';

/**
 * The video vendor's status surface, and the webhook secret it echoes back.
 *
 * Inside `src/lib/drivers/` because it names a vendor, and the isolation check refused the
 * first version of this that lived in `src/lib/generate/`. That refusal was right for a
 * better reason than the rule states: **the URL construction is the security control**, and
 * a security control belongs with the knowledge it depends on rather than scattered across
 * whichever module happened to need it.
 *
 * ** NEVER CALLED. ** The host is refused by this environment's egress policy.
 */

/** The header the vendor echoes the shared secret back in. */
export const WEBHOOK_SECRET_HEADER = 'x-webhook-secret-key';

/**
 * The secret a callback must present.
 *
 * Returns null when unset, so the caller refuses rather than accepting unauthenticated
 * callbacks — a deployment whose webhook security depends on nobody finding the URL is not
 * a deployment with webhook security.
 */
export function expectedWebhookSecret(): string | null {
  return env.HIGGSFIELD_WEBHOOK_SECRET ?? null;
}

/**
 * The documented status shape. Never observed.
 *
 * The result URL is read from `raw` in preference to `min`: `min` is a downscaled preview,
 * and ingesting it would put a thumbnail into the timeline that plays correctly and looks
 * soft, which is the kind of defect that survives review.
 */
export const JobStatusSchema = z.object({
  status: z.string().min(1),
  jobs: z
    .array(
      z.object({
        status: z.string().min(1),
        results: z
          .object({
            raw: z.object({ url: z.url() }).optional(),
            min: z.object({ url: z.url() }).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * Ask the vendor what actually happened to a job.
 *
 * `jobId` must come from a row we already hold — never from a request body. The URL is
 * **constructed here** from the configured base and that id, and this is the line that makes
 * confirm-before-write mean anything: the callback carries a bearer secret rather than a
 * signature, so a leaked secret forges a completion, and the only thing preventing a forged
 * completion from landing an asset is that the confirmation goes somewhere the forger does
 * not control.
 *
 * A payload-supplied `status_url` would let a forger point this at their own server. Then
 * the confirmation costs a round trip and prevents nothing.
 */
export async function fetchJobStatus(params: {
  jobId: string;
  apiKey: string;
  apiSecret: string;
}): Promise<JobStatus> {
  const url = `${env.HIGGSFIELD_API_BASE_URL}/v1/job-sets/${encodeURIComponent(params.jobId)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Key ${params.apiKey}:${params.apiSecret}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(env.DRIVER_TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Status fetch for ${params.jobId} returned HTTP ${response.status}`);
  }

  const parsed = JobStatusSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error(
      `Status response for ${params.jobId} did not match the documented shape: ` +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  return parsed.data;
}

/** The result URL, preferring full resolution over the preview. */
export function resultUrl(status: JobStatus): string | null {
  const job = status.jobs?.[0];
  return job?.results?.raw?.url ?? job?.results?.min?.url ?? null;
}
