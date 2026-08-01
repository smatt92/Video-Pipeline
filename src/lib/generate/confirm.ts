import 'server-only';

import { primaryForKind } from '../drivers/catalog';
import { fetchJobStatus, resultUrl } from '../drivers/video-status';
import type { Db } from '../db/server';
import { requireCredential } from '../integrations/credentials';

/**
 * Confirm a claimed completion against the vendor, then write results.
 *
 * ** NEVER RUN. ** The vendor host is refused by this environment's egress policy.
 *
 * ── The URL is constructed, never received ───────────────────────────────────
 *
 * This is the security-critical line in the whole stage. The callback carries a shared
 * secret rather than a signature (ADR 0004), so a leaked secret is a forged completion —
 * and the only thing standing between that and a written asset is that the confirmation
 * fetch goes somewhere the attacker does not control.
 *
 * So the status URL is built inside the driver layer from the configured base and the
 * `external_job_id` *already stored on our own row*, never from anything in the request. A
 * payload-supplied `status_url` would let a forger point the confirmation at their own
 * server, which turns confirm-before-write into a formality that costs one extra round trip
 * and prevents nothing. See `drivers/video-status.ts`.
 *
 * A job id that matches no row of ours is refused before any fetch happens, which also
 * means a forged callback cannot be used to make this server issue arbitrary outbound
 * requests.
 */

export type ConfirmOutcome =
  | 'succeeded'
  | 'failed'
  | 'still_running'
  | 'unknown_job'
  | 'disagreed';

export interface ConfirmResult {
  outcome: ConfirmOutcome;
  detail?: string;
}

const TERMINAL_OK = /^(completed|succeeded|success)$/i;
const TERMINAL_BAD = /^(failed|error|nsfw|rejected|canceled|cancelled)$/i;

export async function confirmAndIngest(db: Db, jobId: string): Promise<ConfirmResult> {
  const { data: generation } = await db
    .from('generations')
    .select('id, shot_id, kind, status, external_job_id, driver, model')
    .eq('external_job_id', jobId)
    .maybeSingle();

  // Refused before any outbound request. A callback naming a job we never submitted is
  // either noise or an attempt to use this endpoint as a request proxy; neither deserves a
  // fetch.
  if (!generation) {
    return { outcome: 'unknown_job', detail: `no generation with external_job_id ${jobId}` };
  }

  const video = primaryForKind('video');
  if (!video) throw new Error('No video integration is marked primary in the catalogue.');

  const apiKey = await requireCredential(db, video.slug, video.secretFields[0].key);
  const apiSecret = await requireCredential(db, video.slug, video.secretFields[1].key);

  // The id comes from our own row, and the driver layer builds the URL. Neither comes from
  // the request body — that is the whole confirmation.
  const jobStatus = await fetchJobStatus({
    jobId: generation.external_job_id!,
    apiKey,
    apiSecret,
  });

  const status = jobStatus.status;
  const now = new Date().toISOString();

  if (!TERMINAL_OK.test(status) && !TERMINAL_BAD.test(status)) {
    // The callback said done, the vendor says otherwise. Recorded rather than acted on:
    // this is either a race or a forgery, and both are worth seeing.
    await db
      .from('generations')
      .update({ confirmed_at: now, error_detail: `callback claimed terminal; vendor says "${status}"` })
      .eq('id', generation.id);
    return { outcome: 'still_running', detail: `vendor reports "${status}"` };
  }

  if (TERMINAL_BAD.test(status)) {
    // A failure state is a row, not a swallowed exception.
    await db
      .from('generations')
      .update({
        status: 'failed',
        error_code: 'upstream',
        error_detail: `vendor reported "${status}"`,
        confirmed_at: now,
        completed_at: now,
      })
      .eq('id', generation.id);

    if (generation.shot_id) {
      await db.from('shots').update({ status: 'failed' }).eq('id', generation.shot_id);
    }

    // Deliberately no chained video submit. The still failed; animating a still that does
    // not exist is a call that cannot produce anything and would be billed anyway.
    return { outcome: 'failed', detail: status };
  }

  const assetUrl = resultUrl(jobStatus);

  if (!assetUrl) {
    await db
      .from('generations')
      .update({
        status: 'failed',
        error_code: 'upstream',
        error_detail: 'vendor reported success with no result URL',
        confirmed_at: now,
        completed_at: now,
      })
      .eq('id', generation.id);
    return { outcome: 'disagreed', detail: 'success with no result URL' };
  }

  await db
    .from('generations')
    .update({ status: 'succeeded', confirmed_at: now, completed_at: now })
    .eq('id', generation.id);

  // The download, normalisation and storage write happen in a Trigger task, not here. A
  // Vercel route may not touch media bytes (CLAUDE.md rule 2, 4.5 MB hard cap) and has no
  // ffmpeg. This route moves an id and a URL; the worker moves the file.
  //
  // TODO(gate-4): enqueue 05b-ingest with { generationId, assetUrl }. Left explicit rather
  // than stubbed silently — the confirmation is real, the ingest is not yet wired, and a
  // generation that succeeds with no asset row is visible in the shot grid as exactly that.
  return { outcome: 'succeeded', detail: assetUrl };
}
