import { primaryForKind } from '../drivers/catalog';
import { submitGeneration } from '../drivers/video-submit';
import { dispositionFor } from '../drivers/types';
import type { Db } from '../db/server';
import type { Json } from '../db/types';
import { currentRate } from '../cost/rate-card';
import { generationKey } from './keys';

/**
 * Stage 5 — submit a script's compiled shots for generation.
 *
 * ** Still never run against the real vendor. ** The host requires the preview deploy. What
 * changed is that there is now something to run: this function used to price the work,
 * write the estimate row, insert a `generations` row and mark the shot `generating` — and
 * never call anything. A `queued` generation with no `external_job_id` can never be matched
 * to a callback, so the shot would have sat in `generating` for ever while the ledger
 * carried a charge for a call that did not happen.
 *
 * The submit is now real (`src/lib/drivers/video-submit.ts`), which means a missing or
 * rejected credential produces a refusal from the vendor rather than a silent success.
 *
 * ── The chain, and why a failed still must not bill a video ──────────────────
 *
 * A shot is two generations, not one: text→image produces a still, image→video animates
 * it. `parent_generation_id` (0003) links them, and the comment there is explicit that
 * cost per shot is the sum of the chain rather than the last link.
 *
 * The ordering rule is the interesting part. The video call is only submitted once the
 * still has *succeeded*, because a video generated from a still that does not exist is a
 * call that cannot produce anything and will be billed anyway. That is the single easiest
 * way to spend money on nothing in this pipeline, and it is prevented structurally: the
 * video submit lives in the webhook handler for the still, not in the fan-out.
 *
 * So the fan-out below submits **stills only**. The video half is driven by completions.
 *
 * ── Concurrency comes from the integration record ────────────────────────────
 *
 * Not a constant, and not the Trigger queue limit — those bound *runs*. This bounds
 * in-flight submits against an account-wide vendor limit, and its source is recorded so a
 * screen cannot present a fallback as a reading.
 */

export interface SubmitDeps {
  db: Db;
  apiKey: string;
  apiSecret: string;
  webhookBaseUrl: string;
  webhookSecret: string;
  usdInrRate: number;
  concurrency: number;
  log?: { info(m: string, d?: unknown): void; error(m: string, d?: unknown): void };
}

export type SubmitOutcome =
  | { ok: true; submitted: number; skipped: { shotId: string; reason: string }[] }
  | { ok: false; code: string; detail: string };

const noop = { info: () => {}, error: () => {} };

/**
 * Refuse to submit anything that cannot be priced.
 *
 * Rule 5, and on a fresh install this refuses: the credit rates are seeded at zero and
 * unverified because nobody publishes them, and they have to be read off an observed
 * balance delta. Refusing is correct — an unverified rate means no rupee figure anywhere,
 * and a submit that cannot be costed is a submit that must not happen.
 */
async function requirePricing(db: Db, driver: string, model: string, endpoint: string) {
  const rate = await currentRate(db, { driver, model, endpoint, unit: 'credit' });
  if (!rate.found) {
    throw new Error(
      `Refusing to submit: ${driver}/${model} cannot be priced (${rate.reason}). ${rate.detail}`,
    );
  }
  return rate.rate;
}

export async function submitShots(
  scriptId: string,
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  const { db, usdInrRate } = deps;
  const log = deps.log ?? noop;

  const video = primaryForKind('video');
  if (!video) throw new Error('No video integration is marked primary in the catalogue.');

  const { data: shots, error } = await db
    .from('shots')
    .select('id, idx, description, duration_s, duration_source, compiled_params, compile_note, prompt_id, character_id, status')
    .eq('script_id', scriptId)
    .order('idx');

  if (error) throw new Error(`Reading shots failed: ${error.message}`);

  const skipped: { shotId: string; reason: string }[] = [];
  const ready: typeof shots = [];

  for (const shot of shots ?? []) {
    if (!shot.compiled_params || !shot.prompt_id) {
      skipped.push({
        shotId: shot.id,
        reason:
          shot.compile_note ??
          'no compiled parameters — stage 4 found no library recipe for this shot',
      });
      continue;
    }
    // The audio-first inversion exists so video is generated against measured speech.
    // Submitting against an estimate spends the expensive artifact's budget on a guess.
    if (shot.duration_source !== 'derived_from_vo') {
      skipped.push({
        shotId: shot.id,
        reason:
          'duration is still the shotlist estimate. Run stage 6 first — generating video ' +
          'against a word-count guess is what the audio-first ordering exists to prevent.',
      });
      continue;
    }
    ready.push(shot);
  }

  if (ready.length === 0) {
    return { ok: true, submitted: 0, skipped };
  }

  // Priced before anything is submitted, not per shot. Discovering on shot four that the
  // rate is unverified would leave three billed calls unaccounted.
  const model = readModel(ready[0].compiled_params);
  const rate = await requirePricing(db, video.slug, model, '/v1/text2image/soul');

  let submitted = 0;
  const queue = [...ready];

  // A fixed pool rather than Promise.all: the ceiling is the account's, and firing every
  // shot at once is how an undocumented limit gets found by a fan-out rather than by a
  // probe.
  const workers = Array.from({ length: Math.max(1, deps.concurrency) }, async () => {
    for (;;) {
      const shot = queue.shift();
      if (!shot) return;

      const params = asRecord(shot.compiled_params);

      // The character reference, refused rather than dropped — the same rule compilation
      // applies. A recipe that cannot carry the reference generates a different-looking
      // person, which destroys the asset the reference exists to build.
      if (shot.character_id) {
        const { data: prompt } = await db
          .from('prompts')
          .select('accepts_character_ref, name')
          .eq('id', shot.prompt_id!)
          .maybeSingle();

        if (!prompt?.accepts_character_ref) {
          skipped.push({
            shotId: shot.id,
            reason:
              `this shot carries a character reference and recipe "${prompt?.name ?? shot.prompt_id}" ` +
              'is not marked as carrying one through. Refused rather than submitted without ' +
              'it, which would generate a stranger and bill for it.',
          });
          continue;
        }
      }

      const payload = {
        ...params,
        // Stills first. The video call is submitted by the webhook handler once this one
        // succeeds — see the note at the top about not billing a video off a failed still.
        stage: 'still' as const,
        duration_s: Number(shot.duration_s),
      };

      const key = generationKey({
        shotId: shot.id,
        attempt: 1,
        kind: 'image',
        payload,
      });

      // ── Order: generation row, then cost row, then the vendor ───────────────
      //
      // This sequence is not a preference. Two defects made it the only one that works,
      // and both were invisible until stage 5 was wired to a caller and run — everything
      // typechecked, and `cost_ledger` has a shape no type can express.
      //
      // **The estimate row must name a subject.** `cost_ledger_has_subject` requires one
      // of generation_id / render_id / script_id / concept_id / studio_session_id. The
      // original wrote all of them null and would have been refused on the first real
      // submit. `script_id` looks like the obvious answer and is wrong: the unique index
      // on (script_id, stage, entry_kind, unit) exists for once-per-script LLM charges,
      // so the second shot of any script would collide with the first. The subject is the
      // generation — which means the generation row has to exist first.
      //
      // Rule 5 still holds, exactly. "Before the result comes back" is the requirement,
      // not "before anything else"; the row that precedes the cost row here is our own,
      // costs nothing, and is what the charge is *about*. The vendor is not called until
      // both are down.
      //
      // The row goes in as `submitting` and the vendor's job id is
      // written onto it afterwards. Row-then-call rather than call-then-row: a crash
      // between the two must leave evidence that a submit was attempted, and the
      // idempotency key is what stops the retry from becoming a second charge. The
      // reverse order loses the whole generation if the process dies mid-flight, and the
      // money is already gone by then.
      const { data: created, error: genError } = await db
        .from('generations')
        .insert({
          shot_id: shot.id,
          kind: 'image',
          driver: video.slug,
          model,
          request_payload: payload as Json,
          idempotency_key: key,
          status: 'submitting',
          unit_cost_snapshot: rate.unitCostUsd,
          cost_inr: rate.unitCostUsd * usdInrRate,
        })
        .select('id')
        .maybeSingle();

      if (genError) {
        // A duplicate key is not an error. It is the constraint doing its job on a retry —
        // this exact submit already exists and must not be billed again.
        if (/duplicate key|unique constraint/i.test(genError.message)) {
          log.info('already submitted, skipping', { shotId: shot.id, key });
          continue;
        }
        throw new Error(`Generation insert failed for shot ${shot.id}: ${genError.message}`);
      }

      const generationId = created?.id;
      if (!generationId) {
        throw new Error(`Generation insert for shot ${shot.id} returned no id.`);
      }

      // ── The charge, before the call ─────────────────────────────────────────
      //
      // **Insert, not upsert.** `cost_ledger_generation_entry_key` is a *partial* unique
      // index — `where generation_id is not null` — and Postgres cannot infer a partial
      // index for ON CONFLICT unless the statement repeats its predicate, which supabase-js
      // gives no way to express. The upsert failed with "no unique or exclusion constraint
      // matching the ON CONFLICT specification" against a correctly migrated database.
      //
      // So a duplicate key is caught rather than avoided, which is the same idiom the
      // generation insert above already uses, and is the one that works with a partial
      // index. A duplicate here means a retry of a submit that was already charged — the
      // charge stands, and the call must not repeat.
      const { error: costError } = await db.from('cost_ledger').insert({
        generation_id: generationId,
        driver: video.slug,
        entry_kind: 'estimate',
        unit: 'credit',
        quantity: 1,
        cost_usd: rate.unitCostUsd,
        cost_inr: rate.unitCostUsd * usdInrRate,
        usd_inr_rate: usdInrRate,
        idempotency_key: `${key}:estimate`,
      });

      if (costError && !/duplicate key|unique constraint/i.test(costError.message)) {
        // Rule 5 has no exceptions, so a charge that cannot be recorded is a call that
        // must not happen. The generation row is left in `submitting` with nothing behind
        // it, which `v_stuck_submits` surfaces — visibly wrong beats silently unbilled.
        log.error('cost row refused before submit; not submitting', {
          shotId: shot.id,
          error: costError.message,
        });
        skipped.push({
          shotId: shot.id,
          reason: `cost row could not be written, so nothing was submitted: ${costError.message}`,
        });
        continue;
      }

      const result = await submitGeneration({
        endpoint: '/v1/text2image/soul',
        params: payload,
        apiKey: deps.apiKey,
        apiSecret: deps.apiSecret,
        webhookBaseUrl: deps.webhookBaseUrl,
        webhookSecret: deps.webhookSecret,
      });

      if (!result.ok) {
        // A failure state is a row, not a swallowed exception — and not a thrown one
        // either, because one shot's refusal must not abandon the other five. The
        // disposition is stored rather than acted on here: whether to retry is the
        // task's decision, and it needs to see every shot's outcome to make it.
        await db
          .from('generations')
          .update({
            status: 'failed',
            error_code: result.code,
            error_detail: result.detail,
            completed_at: new Date().toISOString(),
          })
          .eq('id', generationId);

        skipped.push({
          shotId: shot.id,
          reason: `vendor refused the submit (${result.code}, ${dispositionFor(result.code)}): ${result.detail}`,
        });
        continue;
      }

      await db
        .from('generations')
        .update({ status: 'queued', external_job_id: result.jobId })
        .eq('id', generationId);

      submitted++;
      await db.from('shots').update({ status: 'generating' }).eq('id', shot.id);
    }
  });

  await Promise.all(workers);

  log.info('submitted', { submitted, skipped: skipped.length, concurrency: deps.concurrency });
  return { ok: true, submitted, skipped };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function readModel(params: unknown): string {
  const m = asRecord(params).model;
  if (typeof m !== 'string' || !m) {
    throw new Error(
      'A compiled shot carries no model. Compilation writes it from the library recipe, so ' +
        'this row was written by something other than stage 4.',
    );
  }
  return m;
}
