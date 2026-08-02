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
 *
 * ── A replayed genuine callback is the other threat ──────────────────────────
 *
 * Forgery needs the secret. Replay needs nothing: anyone who can see one real delivery can
 * send it again byte for byte, and the vendor itself redelivers on any timeout. Before
 * 0015 that was not handled — `confirmed_at` was written on every delivery and read by
 * nothing, so a second callback re-fetched the vendor, rewrote the timestamps and, at
 * Gate 4, would have enqueued the ingest twice.
 *
 * Two defences, and the second is the one that actually holds:
 *
 *   A fast path. `record_webhook_delivery` returns `already_confirmed`, so a replay
 *   returns without an outbound request at all. This is an optimisation — it keeps a
 *   redelivery storm off a vendor with undocumented rate limits — not the guarantee.
 *
 *   **Compare-and-set.** The terminal write goes through `confirm_generation_once`, whose
 *   `where confirmed_at is null` means exactly one caller can ever win. Everything with a
 *   cost or a side effect hangs off that boolean. The fast path can be lost to a race by
 *   two simultaneous deliveries; this cannot.
 */

export type ConfirmOutcome =
  | 'succeeded'
  | 'failed'
  | 'still_running'
  | 'unknown_job'
  | 'disagreed'
  /** A replay, or a vendor redelivery. Recognised and ignored, never re-acted on. */
  | 'already_confirmed';

export interface ConfirmResult {
  outcome: ConfirmOutcome;
  detail?: string;
}

const TERMINAL_OK = /^(completed|succeeded|success)$/i;
const TERMINAL_BAD = /^(failed|error|nsfw|rejected|canceled|cancelled)$/i;

export async function confirmAndIngest(db: Db, jobId: string): Promise<ConfirmResult> {
  const { data: generation } = await db
    .from('generations')
    .select('id, shot_id, kind, status, external_job_id, driver, model, confirmed_at')
    .eq('external_job_id', jobId)
    .maybeSingle();

  // Refused before any outbound request. A callback naming a job we never submitted is
  // either noise or an attempt to use this endpoint as a request proxy; neither deserves a
  // fetch.
  if (!generation) {
    return { outcome: 'unknown_job', detail: `no generation with external_job_id ${jobId}` };
  }

  // The fast path for a replay. Not the guarantee — two simultaneous deliveries can both
  // read null here — but it keeps a redelivery storm from becoming a burst of requests at
  // a vendor whose rate limits are undocumented and fail silently. The guarantee is
  // `confirm_generation_once` below.
  if (generation.confirmed_at) {
    return {
      outcome: 'already_confirmed',
      detail: `confirmed at ${generation.confirmed_at}; this delivery changed nothing`,
    };
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

  /**
   * The terminal transition, exactly once.
   *
   * `confirm_generation_once` carries `where confirmed_at is null`, so the database — not
   * this process — decides who wins. Returns false to every caller after the first, and
   * every side effect below hangs off that boolean.
   */
  const settle = async (
    next: 'succeeded' | 'failed',
    errorCode: string | null,
    errorDetail: string | null,
  ): Promise<boolean> => {
    // `?? undefined`, not `?? null`: the SQL parameters carry DEFAULT null, so the
    // generated Args type makes them optional rather than nullable, and an explicit null
    // is a type error. Omitting them lets the default apply, which is the same value.
    const { data, error } = await db.rpc('confirm_generation_once', {
      p_generation_id: generation.id,
      p_status: next,
      p_error_code: errorCode ?? undefined,
      p_error_detail: errorDetail ?? undefined,
    });
    if (error) throw new Error(`confirm_generation_once failed: ${error.message}`);
    return data === true;
  };

  if (!TERMINAL_OK.test(status) && !TERMINAL_BAD.test(status)) {
    /**
     * The callback said done, the vendor says otherwise — a race, or a forgery.
     *
     * `confirmed_at` is deliberately NOT set here, and that is a change from the first
     * version. Nothing was confirmed: the vendor is still working. Stamping it would have
     * made the fast path above reject the real completion callback when it arrived
     * minutes later, turning a disagreement into a permanently stuck generation. The
     * disagreement is recorded where it belongs, on the row, without claiming settlement.
     */
    await db
      .from('generations')
      .update({ error_detail: `callback claimed terminal; vendor says "${status}"` })
      .eq('id', generation.id);
    return { outcome: 'still_running', detail: `vendor reports "${status}"` };
  }

  if (TERMINAL_BAD.test(status)) {
    // A failure state is a row, not a swallowed exception.
    const won = await settle('failed', 'upstream', `vendor reported "${status}"`);
    if (!won) {
      return { outcome: 'already_confirmed', detail: 'another delivery settled this first' };
    }

    if (generation.shot_id) {
      await db.from('shots').update({ status: 'failed' }).eq('id', generation.shot_id);
    }

    // Deliberately no chained video submit. The still failed; animating a still that does
    // not exist is a call that cannot produce anything and would be billed anyway.
    return { outcome: 'failed', detail: status };
  }

  const assetUrl = resultUrl(jobStatus);

  if (!assetUrl) {
    const won = await settle('failed', 'upstream', 'vendor reported success with no result URL');
    if (!won) {
      return { outcome: 'already_confirmed', detail: 'another delivery settled this first' };
    }
    return { outcome: 'disagreed', detail: 'success with no result URL' };
  }

  const won = await settle('succeeded', null, null);
  if (!won) {
    // Lost the race to a simultaneous delivery. Returning here rather than falling through
    // is the entire point: what follows is the chained submit and the ingest enqueue, and
    // both spend money.
    return { outcome: 'already_confirmed', detail: 'another delivery settled this first' };
  }

  // The download, normalisation and storage write happen in a Trigger task, not here. A
  // Vercel route may not touch media bytes (CLAUDE.md rule 2, 4.5 MB hard cap) and has no
  // ffmpeg. This route moves an id and a URL; the worker moves the file.
  //
  // TODO(gate-4): enqueue 05b-ingest with { generationId, assetUrl }. Left explicit rather
  // than stubbed silently — the confirmation is real, the ingest is not yet wired, and a
  // generation that succeeds with no asset row is visible in the shot grid as exactly that.
  //
  // Whatever goes here is reached only after `settle()` returned true, which is what makes
  // it safe: a replayed callback returns above and never gets this far. The same applies
  // to the chained soul → dop submit when it lands. Both spend money, and neither may be
  // guarded by an application-level read of `confirmed_at`.
  return { outcome: 'succeeded', detail: assetUrl };
}
