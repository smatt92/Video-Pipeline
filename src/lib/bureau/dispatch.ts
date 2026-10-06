
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import type { JobPollResult, JobSubmitResult } from '../drivers/jobs';
import { providerUsesWebhook } from '../drivers/jobs';
import { fits, headroom, nextIstMidnight } from './caps';
import type { IngestResult } from '../ingest/run';

/**
 * The generation queue's worker side: claim → submit → (webhook | poll) → ingest → settle.
 *
 * Concurrency is the database's: `claim_gen_jobs` hands out at most
 * `provider_limits.max_concurrency − in-flight` rows under a per-provider advisory lock, with
 * SKIP LOCKED, and nothing on a killed channel (verify:bureau asserts that at the consumer).
 * This module never decides how many to run.
 *
 * Money: the `generations` row and its `cost_ledger` estimate are written BEFORE the vendor
 * is called (rule 5), keyed by the job's idempotency key (rule 6) — a retry finds the row
 * and does not submit twice.
 *
 * Throttling: a 429 / THROTTLED moves the job to `throttled` with `next_attempt_at` from the
 * vendor's Retry-After, else exponential backoff (30 s doubling, 15 min cap). The job keeps
 * its attempt count, so a vendor that throttles forever exhausts `max_attempts` and fails as
 * a row, visible on the Generation monitor.
 */

export interface DispatchDeps {
  db: Db;
  worker: string;
  usdInrRate: number;
  credentialsFor(provider: string): Promise<Record<string, string> | null>;
  submit(input: { provider: string; model: string; endpoint: string | null; params: Record<string, unknown>; credentials: Record<string, string>; webhook?: { baseUrl: string; secret: string } }): Promise<JobSubmitResult>;
  poll(input: { provider: string; requestId: string; pollRef: Record<string, string>; credentials: Record<string, string> }): Promise<JobPollResult>;
  ingest(input: { generationId: string; assetUrl: string; headers: Record<string, string> }): Promise<IngestResult>;
  webhook?: { baseUrl: string; secret: string };
  now?: () => Date;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export function backoffS(attempts: number, retryAfterS: number | null): number {
  if (retryAfterS && retryAfterS > 0) return Math.min(retryAfterS, 900);
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 900);
}

export async function dispatchProvider(provider: string, max: number, deps: DispatchDeps) {
  const { db } = deps;
  const log = deps.log ?? { info() {}, error() {} };
  const now = deps.now ?? (() => new Date());
  const creds = await deps.credentialsFor(provider);
  if (!creds) return { claimed: 0, submitted: 0, refused: 'no credentials' };

  const { data: claimed, error } = await db.rpc('claim_gen_jobs', { p_provider: provider, p_worker: deps.worker, p_max: max });
  if (error) throw new Error(`claim failed: ${error.message}`);
  let submitted = 0;
  let deferred = 0;
  for (const job of claimed ?? []) {
    // ── The caps, per job, before any money moves ──────────────────────────
    // Re-read each time: the previous job's estimate is in the ledger now.
    const { data: epRow } = job.episode_id ? await db.from('episodes').select('channel_id, kind').eq('id', job.episode_id).maybeSingle() : { data: null };
    if (epRow) {
      const h = await headroom(db, epRow.channel_id, epRow.kind as 'short' | 'long_form');
      const cost = job.estimate_inr === null ? Number.POSITIVE_INFINITY : Number(job.estimate_inr);
      if (!fits(h, cost)) {
        // Back to the queue until the daily cap resets, and the claim's attempt is returned:
        // a cap is not the job failing, and must not exhaust its retries.
        await db
          .from('gen_jobs')
          .update({ status: 'throttled', attempts: Math.max(0, job.attempts - 1), next_attempt_at: nextIstMidnight(now()), last_error: `over the spend cap (daily headroom ${h.dailyInr === null ? 'unknown' : `₹${h.dailyInr.toFixed(0)}`}, monthly ${h.monthlyInr === null ? 'unknown' : `₹${h.monthlyInr.toFixed(0)}`})`, last_error_code: 'cap', updated_at: now().toISOString() })
          .eq('id', job.id);
        deferred++;
        continue;
      }
    }

    // ── The money, before the call ───────────────────────────────────────────
    let generationId = job.generation_id;
    if (!generationId) {
      const { data: gen, error: gErr } = await db
        .from('generations')
        .upsert(
          { shot_id: job.shot_id, kind: 'video', driver: provider, model: job.model, request_payload: job.params as Json, idempotency_key: job.idempotency_key, status: 'submitting', origin: 'pipeline' },
          { onConflict: 'idempotency_key' },
        )
        .select('id')
        .single();
      if (gErr || !gen) {
        await fail(db, job.id, 'ledger', `generation row could not be written: ${gErr?.message}`, now());
        continue;
      }
      generationId = gen.id;
      const costInr = job.estimate_inr === null ? null : Number(job.estimate_inr);
      if (costInr === null) {
        await fail(db, job.id, 'unpriced', 'the job carries no estimate — refusing to submit what cannot be ledgered', now());
        continue;
      }
      const { error: lErr } = await db.from('cost_ledger').insert({
        generation_id: generationId,
        driver: provider,
        entry_kind: 'estimate',
        unit: 'second',
        quantity: Number(job.duration_s),
        cost_usd: costInr / deps.usdInrRate,
        cost_inr: costInr,
        usd_inr_rate: deps.usdInrRate,
        idempotency_key: `${job.idempotency_key}:estimate`,
        stage: '05-generate',
      });
      if (lErr && !/duplicate key|unique/i.test(lErr.message)) {
        await fail(db, job.id, 'ledger', `cost row could not be written: ${lErr.message}`, now());
        continue;
      }
      await db.from('gen_jobs').update({ generation_id: generationId }).eq('id', job.id);
    }

    const webhook = providerUsesWebhook(provider) ? deps.webhook : undefined;
    const r = await deps.submit({ provider, model: job.model, endpoint: job.endpoint, params: job.params as Record<string, unknown>, credentials: creds, webhook });
    if (r.ok) {
      submitted++;
      await db.from('gen_jobs').update({ status: 'submitted', request_id: r.requestId, poll_ref: r.pollRef as Json, updated_at: now().toISOString() }).eq('id', job.id);
      await db.from('generations').update({ external_job_id: r.requestId, status: 'queued' }).eq('id', generationId);
    } else if (r.code === 'rate_limited' || r.code === 'concurrency_limited') {
      const wait = backoffS(job.attempts, r.retryAfterS);
      await db
        .from('gen_jobs')
        .update({ status: 'throttled', next_attempt_at: new Date(now().getTime() + wait * 1000).toISOString(), last_error: r.detail, last_error_code: r.code, updated_at: now().toISOString() })
        .eq('id', job.id);
      log.info('throttled', { job: job.id, provider, wait });
    } else {
      const retryable = ['upstream', 'timeout'].includes(r.code) && job.attempts < job.max_attempts;
      await db
        .from('gen_jobs')
        .update({ status: retryable ? 'queued' : 'failed', next_attempt_at: new Date(now().getTime() + backoffS(job.attempts, null) * 1000).toISOString(), last_error: r.detail, last_error_code: r.code, updated_at: now().toISOString() })
        .eq('id', job.id);
      if (!retryable) await db.from('generations').update({ status: 'failed', error_code: r.code, error_detail: r.detail.slice(0, 1000) }).eq('id', generationId);
    }
  }
  return { claimed: (claimed ?? []).length, submitted, deferred };
}

async function fail(db: Db, jobId: string, code: string, detail: string, at: Date) {
  await db.from('gen_jobs').update({ status: 'failed', last_error: detail, last_error_code: code, updated_at: at.toISOString() }).eq('id', jobId);
}

/**
 * Advance every submitted job. Webhook providers are NOT polled — their callback route
 * confirms and ingests; this only reads the outcome off the `generations` row (rule 4).
 */
export async function advanceSubmitted(provider: string, deps: DispatchDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const { data: jobs } = await db
    .from('gen_jobs')
    .select('id, shot_id, generation_id, request_id, poll_ref, attempts, max_attempts')
    .eq('provider', provider)
    .eq('status', 'submitted');
  let done = 0;
  const creds = jobs?.length && !providerUsesWebhook(provider) ? await deps.credentialsFor(provider) : null;
  for (const job of jobs ?? []) {
    if (providerUsesWebhook(provider)) {
      const { data: gen } = await db.from('generations').select('status, error_code, error_detail').eq('id', job.generation_id!).single();
      if (!gen || !['succeeded', 'failed', 'cancelled', 'timeout'].includes(gen.status)) continue;
      if (gen.status === 'succeeded') {
        const { data: asset } = await db.from('assets').select('id').eq('generation_id', job.generation_id!).not('normalized_at', 'is', null).limit(1).maybeSingle();
        if (!asset) continue; // ingest still running
      }
      await settleJob(db, job, gen.status === 'succeeded', gen.error_detail ?? gen.error_code ?? gen.status, now());
      done++;
      continue;
    }
    if (!creds || !job.request_id) continue;
    const r = await deps.poll({ provider, requestId: job.request_id, pollRef: (job.poll_ref ?? {}) as Record<string, string>, credentials: creds });
    if (r.state === 'running') continue;
    if (r.state === 'failed') {
      if (r.code === 'rate_limited') continue; // the poll was throttled, not the job
      await db.from('generations').update({ status: 'failed', error_code: r.code, error_detail: r.detail.slice(0, 1000), completed_at: now().toISOString() }).eq('id', job.generation_id!);
      await settleJob(db, job, false, r.detail, now());
      done++;
      continue;
    }
    // The poll is the vendor telling us; that is the confirmation ingest requires.
    await db.from('generations').update({ status: 'succeeded', confirmed_at: now().toISOString(), completed_at: now().toISOString() }).eq('id', job.generation_id!);
    const ing = await deps.ingest({ generationId: job.generation_id!, assetUrl: r.outputUrl, headers: r.downloadHeaders });
    await settleJob(db, job, ing.ok, ing.ok ? null : `${ing.code}: ${ing.detail}`, now());
    done++;
  }
  return { advanced: done };
}

async function settleJob(db: Db, job: { id: string; shot_id: string | null }, ok: boolean, detail: string | null, at: Date) {
  await db.from('gen_jobs').update({ status: ok ? 'succeeded' : 'failed', last_error: ok ? null : detail, updated_at: at.toISOString() }).eq('id', job.id);
  if (job.shot_id) await db.from('shots').update({ status: ok ? 'ready' : 'failed' }).eq('id', job.shot_id);
}

/** Episodes parked on a generation wait whose jobs are all terminal: wake them. */
export async function settleEpisodes(db: Db, completeToken: (token: string, output: Record<string, unknown>) => Promise<void>) {
  const { data: eps } = await db.from('episodes').select('id, gen_wait_token').not('gen_wait_token', 'is', null);
  let woken = 0;
  for (const e of eps ?? []) {
    const { data: jobs } = await db.from('gen_jobs').select('status').eq('episode_id', e.id);
    const open = (jobs ?? []).filter((j) => ['queued', 'claimed', 'submitted', 'throttled'].includes(j.status)).length;
    if (open > 0) continue;
    await completeToken(e.gen_wait_token!, { failed: (jobs ?? []).filter((j) => j.status === 'failed').length });
    await db.from('episodes').update({ gen_wait_token: null }).eq('id', e.id);
    woken++;
  }
  return { woken };
}

