import type { z } from 'zod';

import type {
  AssetKind,
  GenerationStatus,
  RowOrigin,
} from '../db/enums';

/**
 * The driver layer.
 *
 * ARCHITECTURE.md §0.1: Higgsfield is not the bet, the loop is. Models rotate quarterly;
 * the accumulated hook-performance data does not. So the vendor is a config value behind
 * an interface, and everything above this file is written as though it does not know
 * which vendor it is talking to.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two interfaces, deliberately
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `VideoDriver` and `AudioDriver` are not unified, and the temptation to unify them
 * should be resisted. Their execution models have nothing in common:
 *
 *              VideoDriver (async job)        AudioDriver (synchronous call)
 *   Execution  submit → webhook → resume      request → response body
 *   Completion a callback, minutes later      the return value, seconds later
 *   Cancel     sometimes, best-effort         meaningless
 *   Throttle   opaque rate limits             hard parallel-request ceiling
 *   Chunking   n/a                            required past a few hundred words
 *
 * Forcing one interface over both produces a `submit()` that returns an already-finished
 * job for audio and a `cancel()` that no audio vendor can implement — an abstraction that
 * lies about half its implementations.
 *
 * What they DO share is the shape of a *result* and the shape of a *cost*. That is the
 * real abstraction, and it is what lets `generations`, `assets` and `cost_ledger` hold
 * both without special-casing. Everything shared lives in the first section below.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Two rules this file encodes structurally
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. A driver is constructed from an integration record, never from module-level
 *    `process.env`. Credentials live in Vault and are resolved per call, so rotating a
 *    key is a database write rather than a redeploy.
 * 2. A call that cannot be priced does not happen. `CostEstimate` is a union whose
 *    unpriced arm carries a reason, and submit paths are required to refuse it — because
 *    cost-per-video cannot be backfilled (CLAUDE.md rule 5), and a wrong cost is worse
 *    than a missing one because it gets believed.
 */

// ═════════════════════════════════════════════════════════════════════════════
// Shared: construction
// ═════════════════════════════════════════════════════════════════════════════

/**
 * An integration row with its secrets already resolved.
 *
 * The caller reads Vault; the driver never does. That keeps Vault access on one server-
 * side path that can be audited, and it means a driver can be constructed in a test with
 * a literal object and no Vault at all.
 */
export interface ResolvedIntegration {
  readonly id: string;
  /** Registry key: `integrations.slug`. Also the value written to `generations.driver`. */
  readonly slug: string;
  /** Non-secret configuration from `integrations.config`. Validated by the driver. */
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * Secret material, resolved from Vault immediately before construction.
   *
   * Never log this, never return it from a Server Action, never put it in an error
   * message. The settings UI sees `integrations.last_4` and nothing else.
   */
  readonly secrets: Readonly<Record<string, string>>;
  readonly isEnabled: boolean;
  /**
   * When Test-connection last succeeded. A pipeline task must refuse an integration that
   * has never verified — an untested credential discovered mid-fan-out costs a run.
   */
  readonly lastVerifiedAt: Date | null;
}

export type VideoDriverFactory = (integration: ResolvedIntegration) => VideoDriver;
export type AudioDriverFactory = (integration: ResolvedIntegration) => AudioDriver;

// ═════════════════════════════════════════════════════════════════════════════
// Shared: money
// ═════════════════════════════════════════════════════════════════════════════

/** A row from `rate_card`, already selected for the relevant date. */
export interface RateCardEntry {
  readonly id: string;
  readonly driver: string;
  readonly model: string;
  readonly endpoint: string | null;
  /** Billing unit: 'credit', 'second', 'character'. */
  readonly unit: string;
  readonly unitCost: number;
  readonly currency: string;
  /** False means the number is a guess and nothing may render a rupee figure from it. */
  readonly isVerified: boolean;
}

/**
 * What a call will cost, or why that cannot be said.
 *
 * The unpriced arm is not an error condition to be swallowed — it is the honest answer
 * when the rate card has no verified entry, and the caller is required to act on it. The
 * settings page exists largely to make this arm rare.
 */
export type CostEstimate =
  | {
      readonly kind: 'priced';
      readonly quantity: number;
      readonly unit: string;
      readonly unitCostUsd: number;
      readonly costUsd: number;
      readonly costInr: number;
      /** Snapshotted onto the ledger row so the rupee figure stays explainable later. */
      readonly usdInrRate: number;
      readonly rateCardId: string;
    }
  | {
      readonly kind: 'unpriced';
      readonly reason: 'no_rate_card_entry' | 'rate_unverified' | 'quantity_unknown';
      /** Present when the amount is known but the price per unit is not. */
      readonly quantity?: number;
      readonly unit?: string;
      readonly detail: string;
    };

export function isPriced(
  estimate: CostEstimate,
): estimate is Extract<CostEstimate, { kind: 'priced' }> {
  return estimate.kind === 'priced';
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared: results
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One piece of media a driver produced.
 *
 * Two delivery shapes, because the two execution models genuinely differ: an async video
 * job hands back a URL on the vendor's CDN, while a synchronous speech call hands back
 * bytes. Both must be copied into R2 by the worker — a vendor CDN URL is not durable
 * storage and several expire.
 *
 * Whichever shape arrives, the bytes are handled in `src/trigger/`, never in a route.
 * Vercel caps a function body at 4.5 MB and cannot be raised (CLAUDE.md rule 2).
 */
export type ProducedArtifact =
  | {
      readonly delivery: 'url';
      readonly kind: AssetKind;
      readonly url: string;
      readonly contentType?: string;
      readonly durationS?: number;
      readonly width?: number;
      readonly height?: number;
      /** Vendor thumbnail, where one is offered. Saves generating our own. */
      readonly previewUrl?: string;
      readonly meta?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly delivery: 'bytes';
      readonly kind: AssetKind;
      readonly bytes: Uint8Array;
      readonly contentType: string;
      readonly durationS?: number;
      readonly meta?: Readonly<Record<string, unknown>>;
    };

/**
 * What actually got billed, once the vendor says so.
 *
 * Reconciliation is separate from estimation because the two disagree often enough to
 * matter: content moderation refunds, retried attempts, and per-second billing rounding
 * all move the number after submit.
 */
export interface ActualUsage {
  readonly quantity: number;
  readonly unit: string;
  /** True when the vendor returned credits — written to the ledger as a refund row. */
  readonly refunded?: boolean;
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared: failure
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Normalised failure reasons.
 *
 * The taxonomy exists to drive three different behaviours — retry, queue, or stop — from
 * one place. `rate_limited` and `concurrency_limited` are deliberately distinct: the
 * first wants exponential backoff, the second wants a queue, and treating a concurrency
 * ceiling as a rate limit produces a retry storm that makes the ceiling worse.
 */
export type DriverErrorCode =
  /** Credentials rejected. Never retryable; the integration needs re-verification. */
  | 'auth'
  /** Vendor asked us to slow down. Back off with jitter. */
  | 'rate_limited'
  /** Too many requests in flight. Queue and wait — do not retry-storm. */
  | 'concurrency_limited'
  /** Out of credits or quota. Not retryable, and worth alerting on. */
  | 'insufficient_credits'
  /** We sent something the vendor rejected. Retrying identical input cannot help. */
  | 'invalid_input'
  /** Moderation refused the content. A row, not an exception — and often refunded. */
  | 'content_rejected'
  /** Our own deadline elapsed. The job may still be running on their side. */
  | 'timeout'
  | 'not_found'
  /** Vendor 5xx or transport failure. Retryable. */
  | 'upstream'
  | 'unknown';

/** What the caller should do about a failure. Derived from the code, never guessed. */
export type RetryDisposition = 'fail_fast' | 'retry_with_backoff' | 'queue_and_wait';

export function dispositionFor(code: DriverErrorCode): RetryDisposition {
  switch (code) {
    case 'concurrency_limited':
      return 'queue_and_wait';
    case 'rate_limited':
    case 'upstream':
    case 'timeout':
      return 'retry_with_backoff';
    case 'auth':
    case 'insufficient_credits':
    case 'invalid_input':
    case 'content_rejected':
    case 'not_found':
    case 'unknown':
      return 'fail_fast';
  }
}

/**
 * Every driver failure is one of these. Vendors throw wildly different shapes; normalising
 * at the boundary is the only reason the retry and circuit-breaker logic can be written
 * once instead of per vendor.
 *
 * These become rows. `generations.error_code` takes `code`, `error_detail` takes
 * `message` — failure states are rows, not swallowed exceptions.
 */
export class DriverError extends Error {
  readonly code: DriverErrorCode;
  readonly driver: string;
  /** True only where retrying the *same* request could plausibly succeed. */
  readonly retryable: boolean;
  /** From `Retry-After` or equivalent, when the vendor tells us. */
  readonly retryAfterMs?: number;
  /** The vendor's own code, kept for forensics. Never switched on above this layer. */
  readonly vendorCode?: string;

  constructor(params: {
    code: DriverErrorCode;
    driver: string;
    message: string;
    retryAfterMs?: number;
    vendorCode?: string;
    cause?: unknown;
  }) {
    super(params.message, { cause: params.cause });
    this.name = 'DriverError';
    this.code = params.code;
    this.driver = params.driver;
    this.retryable = dispositionFor(params.code) !== 'fail_fast';
    this.retryAfterMs = params.retryAfterMs;
    this.vendorCode = params.vendorCode;
  }

  get disposition(): RetryDisposition {
    return dispositionFor(this.code);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Shared: health
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Result of the settings page's Test-connection action: the cheapest real call the vendor
 * offers. Writes `integrations.last_verified_at` / `last_error` and an
 * `integration_events` row.
 */
export interface VerifyResult {
  readonly ok: boolean;
  /** Safe to show in the UI. Must never contain secret material. */
  readonly detail: string;
  readonly balance?: AccountBalance;
}

/**
 * Remaining credit and, where the vendor has one, its expiry.
 *
 * The expiry clock belongs on screen. Credits that expire ~90 days after purchase are a
 * cost the ledger cannot see, because nothing is billed at the moment they evaporate.
 */
export interface AccountBalance {
  readonly credits: number | null;
  readonly currency?: string;
  readonly expiresAt?: Date;
}

// ═════════════════════════════════════════════════════════════════════════════
// VideoDriver
// ═════════════════════════════════════════════════════════════════════════════

/**
 * What a video vendor can actually do.
 *
 * Declared rather than assumed, so that callers branch on a capability instead of on a
 * vendor name — which is what keeps the vendor's name out of `src/` (CLAUDE.md rule 1).
 * The awkward values here are the honest ones:
 *
 * - `cancel: 'unsupported'` is a real case. The primary vendor's SDK exposes no cancel
 *   method at all, and its API documents in-progress jobs as uncancellable.
 * - `webhooks: false` is a real case too, and the one that decides whether stage 5 parks
 *   on a wait token or falls back to polling. Rule 4 forbids polling *where a webhook
 *   exists*; it does not forbid a driver that has none.
 * - `requiresKeyframe: true` means text→video is a two-call chain (text→image, then
 *   image→video), so one shot becomes two `generations` rows linked by
 *   `parent_generation_id`, and its cost is the sum of the chain.
 */
export interface VideoDriverCapabilities {
  readonly webhooks: boolean;
  readonly cancel: 'unsupported' | 'best_effort' | 'reliable';
  /** `consume` = can use a reference id it was given; `create` = can mint one. */
  readonly characterRefs: 'none' | 'consume' | 'create';
  readonly balance: boolean;
  readonly requiresKeyframe: boolean;
  /**
   * Hard ceiling on in-flight jobs, or null when the vendor does not publish one. Read
   * from the integration record, not hardcoded — a wrong constant produces a permanent
   * failure rate that reads as a flaky vendor.
   */
  readonly maxConcurrency: number | null;
}

/** A character/consistency reference, so identity survives across shots. */
export interface CharacterRef {
  /** `characters.external_ref_id`. Opaque to everything above the driver. */
  readonly externalRefId: string;
  /** 0..1 where the vendor supports weighting. */
  readonly strength?: number;
}

export interface VideoSubmitRequest {
  /**
   * Ours, not the vendor's. Survives retries so a replayed submit cannot double-charge
   * (CLAUDE.md rule 6). Written to `generations.idempotency_key`, which is NOT NULL.
   */
  readonly idempotencyKey: string;
  readonly model: string;
  /** Vendor endpoint/route. Also the rate-card key, since pricing varies per endpoint. */
  readonly endpoint: string;
  /** Compiled driver params from the prompt library. Production never improvises. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly characterRef?: CharacterRef;
  /**
   * Input image for image→video. Set when chaining off a keyframe generation; the
   * resulting row carries `parent_generation_id`.
   */
  readonly inputImageUrl?: string;
  /**
   * Where the vendor should call back. Ignored when `capabilities.webhooks` is false.
   * Must be a stable public origin — a preview-deployment URL dies on the next push.
   */
  readonly webhookUrl?: string;
  readonly timeoutMs?: number;
  readonly origin?: RowOrigin;
}

export interface VideoSubmitResult {
  readonly externalJobId: string;
  readonly state: GenerationStatus;
  /** For confirming an unsigned webhook, and for polling when there are no webhooks. */
  readonly statusUrl?: string;
  readonly cancelUrl?: string;
  /** Some vendors return finished work synchronously. Rare, but must not be dropped. */
  readonly artifacts?: readonly ProducedArtifact[];
  /** Stored in `generations.request_payload` for replay and forensics. */
  readonly raw: unknown;
}

export interface JobSnapshot {
  readonly externalJobId: string;
  readonly state: GenerationStatus;
  readonly artifacts: readonly ProducedArtifact[];
  readonly usage?: ActualUsage;
  readonly error?: { code: DriverErrorCode; detail: string };
  readonly raw: unknown;
}

/**
 * Cancel is allowed to fail, and allowed not to exist.
 *
 * Returning a value rather than throwing is deliberate: "this vendor has no cancel" is an
 * ordinary answer to a reasonable question, not an exceptional condition, and callers
 * that treat it as one end up wrapping every cancel in a try/catch that swallows real
 * errors alongside it.
 */
export type CancelOutcome =
  | { readonly supported: false; readonly reason: string }
  | { readonly supported: true; readonly cancelled: boolean; readonly reason?: string };

/** A webhook as it arrived, before anything has trusted it. */
export interface RawWebhook {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The unparsed body. Signature schemes that exist require exact bytes. */
  readonly rawBody: string;
  /** Query string of the delivery URL — some vendors round-trip correlation ids here. */
  readonly query?: Readonly<Record<string, string>>;
}

/**
 * A verified webhook.
 *
 * `trusted` is the field that matters. Where a vendor genuinely signs its payloads, a
 * verified signature means the body can be acted on directly. Where the "signature" is a
 * shared secret echoed in a header — which is what the primary vendor does — the delivery
 * proves only that someone knows the secret, so it is a *hint that something changed* and
 * the receiver must confirm against `statusUrl` before writing results.
 *
 * One confirmation call on a webhook is not polling. It is the difference between a
 * pipeline that can be lied to and one that cannot.
 */
export interface WebhookEvent {
  readonly externalJobId: string;
  readonly state: GenerationStatus;
  readonly trusted: 'signed' | 'shared_secret';
  readonly artifacts: readonly ProducedArtifact[];
  readonly usage?: ActualUsage;
  readonly error?: { code: DriverErrorCode; detail: string };
  /** Correlation id we round-tripped through the callback URL, when the vendor allows. */
  readonly correlationId?: string;
  readonly raw: unknown;
}

export type WebhookParseResult =
  | { readonly ok: true; readonly event: WebhookEvent }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'bad_secret' | 'malformed' | 'unknown_job';
      /** What the route should return. 401 for a bad secret, 400 for malformed. */
      readonly httpStatus: number;
      readonly detail: string;
    };

export interface VideoDriver {
  readonly slug: string;
  readonly capabilities: VideoDriverCapabilities;

  /**
   * Submit a generation. Returns as soon as the vendor has accepted the job.
   *
   * The caller writes the `generations` row and its estimate ledger entry *before*
   * calling this, not after — rule 5 is about the moment money is committed, and a
   * process that dies between call and write must not lose the fact that it spent.
   */
  submit(request: VideoSubmitRequest): Promise<VideoSubmitResult>;

  /**
   * Current state of a job. Used to confirm an untrusted webhook, to reconcile after a
   * timeout, and as the completion mechanism for drivers with no webhooks at all.
   */
  status(externalJobId: string): Promise<JobSnapshot>;

  /** Best-effort. See `CancelOutcome` — not supported is a legitimate answer. */
  cancel(externalJobId: string): Promise<CancelOutcome>;

  /**
   * Verify and interpret an incoming webhook. Returns a result rather than throwing so
   * the route can answer with the right status code without a try/catch.
   *
   * A driver with `capabilities.webhooks === false` returns `reason: 'unsupported'`.
   */
  parseWebhook(raw: RawWebhook): Promise<WebhookParseResult>;

  /**
   * What this request will cost, from the supplied rate card. Pure — no network call, so
   * it can run inside the same transaction that writes the ledger row.
   *
   * Returns the unpriced arm rather than guessing. Callers must refuse to submit on it.
   */
  estimateCost(
    request: VideoSubmitRequest,
    rates: readonly RateCardEntry[],
    usdInrRate: number,
  ): CostEstimate;

  /** Cheapest real call the vendor offers. Powers Test-connection. */
  verify(): Promise<VerifyResult>;

  /** Only meaningful when `capabilities.balance` is true. */
  getBalance?(): Promise<AccountBalance>;

  /** Only present when `capabilities.characterRefs === 'create'`. */
  createCharacterRef?(params: {
    name: string;
    referenceUrls: readonly string[];
  }): Promise<{ externalRefId: string }>;
}

// ═════════════════════════════════════════════════════════════════════════════
// AudioDriver
// ═════════════════════════════════════════════════════════════════════════════

/**
 * One word, and when it was actually said.
 *
 * Derived from the vendor's *normalized* alignment — what was spoken ("$5" → "five
 * dollars"), not what was typed. Captions render from this, so raw alignment would put
 * text on screen the viewer never hears.
 *
 * These timings are what make the pipeline audio-first: beat boundaries come from real
 * speech, and `shots.duration_s` is derived from them rather than guessed ahead of time.
 */
export interface WordTiming {
  readonly w: string;
  /** Seconds from the start of this take, before `offset_s` is applied. */
  readonly start: number;
  readonly end: number;
}

export interface AudioDriverCapabilities {
  /**
   * Hard ceiling on *parallel* requests — the throttle unit for speech vendors, and a
   * per-tier number, not a per-minute one. Sourced from the integration record.
   *
   * Null means unknown, and unknown must not be guessed: a hardcoded ceiling above the
   * real one produces a constant failure rate that looks like vendor flakiness.
   */
  readonly maxConcurrency: number | null;
  /** Model-dependent, from config. Past this the caller must chunk. */
  readonly maxCharsPerRequest: number | null;
  readonly wordTimings: boolean;
  readonly phonemeDictionaries: boolean;
  readonly seed: boolean;
  /** Whether takes can be stitched by referencing neighbouring request ids. */
  readonly chunkStitching: boolean;
}

export interface Voice {
  readonly voiceId: string;
  readonly name: string;
  readonly languages: readonly string[];
  readonly previewUrl?: string;
  readonly isCloned: boolean;
}

export interface SynthesisRequest {
  /** Ours. Audio is cheap, but a double-charge is still a double-charge. */
  readonly idempotencyKey: string;
  readonly text: string;
  readonly voiceId: string;
  readonly model: string;
  readonly language: string;
  readonly seed?: number;
  /**
   * Number/date/currency expansion. Worth being explicit about: on the cheapest models
   * it defaults off, which silently reads "₹5,000" as digits.
   */
  readonly normalization?: 'auto' | 'on' | 'off';
  /** Compiled from `pronunciations`. Vendors cap how many may be sent per request. */
  readonly dictionaryIds?: readonly string[];
  /** Chunk stitching context, to stop accent and pace drifting between takes. */
  readonly previousRequestIds?: readonly string[];
  readonly nextRequestIds?: readonly string[];
  readonly timeoutMs?: number;
}

export interface SynthesisResult {
  readonly artifact: Extract<ProducedArtifact, { delivery: 'bytes' }>;
  readonly wordTimings: readonly WordTiming[];
  readonly usage: ActualUsage;
  /** Needed as `previousRequestIds` for the following chunk. */
  readonly requestId?: string;
  readonly raw: unknown;
}

/**
 * Speech synthesis.
 *
 * Note what is absent: no `submit`, no `status`, no `cancel`, no `parseWebhook`. The call
 * is synchronous and the response body *is* the completion signal, so those methods would
 * be ceremony with nothing behind them.
 *
 * Note also that `synthesize` returns bytes. It must only ever be invoked from
 * `src/trigger/` — a Vercel route cannot carry them (rule 2).
 */
export interface AudioDriver {
  readonly slug: string;
  readonly capabilities: AudioDriverCapabilities;

  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;

  listVoices(): Promise<readonly Voice[]>;

  /**
   * Cost before the call. Character count is knowable up front, which is why audio can be
   * priced exactly where video can only be estimated.
   */
  estimateCost(
    request: Pick<SynthesisRequest, 'text' | 'model'>,
    rates: readonly RateCardEntry[],
    usdInrRate: number,
  ): CostEstimate;

  verify(): Promise<VerifyResult>;

  getBalance?(): Promise<AccountBalance>;
}

// ═════════════════════════════════════════════════════════════════════════════
// Boundary parsing
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Every driver parses vendor responses through a Zod schema and returns the types above.
 * Never `as` a parsed external payload: an unvalidated cast turns a vendor's silent
 * response-shape change into a `undefined` four layers away, in a worker, at 3am.
 *
 * Exported so driver modules share one convention rather than inventing three.
 */
export type BoundarySchema<T> = z.ZodType<T>;

/**
 * Parse a vendor payload, converting a schema failure into a typed driver failure.
 *
 * `invalid_input` is deliberately not the code here — the input was fine, the vendor's
 * output was not, and misclassifying it would send the retry logic down the wrong path.
 */
export function parseBoundary<T>(
  schema: BoundarySchema<T>,
  payload: unknown,
  context: { driver: string; what: string },
): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new DriverError({
      code: 'upstream',
      driver: context.driver,
      message: `${context.driver}: ${context.what} did not match the expected shape — ${result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
      cause: result.error,
    });
  }
  return result.data;
}
