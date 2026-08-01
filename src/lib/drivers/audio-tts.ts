import { TtsResponseSchema, wordsFromCharacters, type WordTiming } from '../voice/timings';

/**
 * The synthesis call. Inside `src/lib/drivers/` because it names a vendor.
 *
 * Not an `AudioDriver` implementation — there is no voice list, no subscription read, no
 * clone management. One endpoint, the one that produces speech and the timings the whole
 * audio-first ordering depends on. The full interface is Gate 2's business.
 *
 * ** NEVER CALLED. ** The vendor host is refused by this environment's egress policy, so
 * every shape below is read from documentation. Recorded in 0008 with the command that
 * proves it.
 */

const BASE = 'https://api.elevenlabs.io';

/**
 * Model per format, from Addendum 02 §2.
 *
 * Not a preference. `eleven_multilingual_v2` is the most consistent across chunk seams,
 * which matters exactly when there are seams — long-form. `eleven_v3` is expressive and
 * carries audio tags, which is what a hook needs. And Telugu is not in the v2 or Flash
 * language lists at all, so for Telugu it is v3 or nothing regardless of format.
 */
export interface ModelChoice {
  model: string;
  maxChars: number;
  reason: string;
}

export function modelFor(params: { format: 'short' | 'long'; language: string }): ModelChoice {
  if (params.language.toLowerCase().startsWith('te')) {
    return {
      model: 'eleven_v3',
      maxChars: 5_000,
      reason:
        'Telugu is not in the v2 or Flash language lists, so this is the only model that ' +
        'speaks it — format does not enter into it.',
    };
  }

  return params.format === 'short'
    ? {
        model: 'eleven_v3',
        maxChars: 5_000,
        reason: 'Expressive, and carries audio tags, which is what a hook is for.',
      }
    : {
        model: 'eleven_multilingual_v2',
        maxChars: 10_000,
        reason: 'Most consistent across chunk seams, which is what long-form has.',
      };
}

// ═════════════════════════════════════════════════════════════════════════════
// Errors
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Two of these are not interchangeable, and treating them as one is the bug this taxonomy
 * exists to prevent.
 *
 *   concurrency_limited  the account's parallel-request ceiling is full. The request was
 *                        never attempted. **Queue it.** Retrying immediately is a
 *                        retry-storm against a limit that only clears when something else
 *                        finishes, and it makes the queue longer rather than shorter.
 *
 *   busy                 the vendor is overloaded. **Back off with jitter.** Retrying
 *                        immediately is the classic thundering herd, and jitter is what
 *                        stops every queued request retrying in lockstep.
 *
 * Backing off on the first wastes a slot that was available; queueing on the second holds
 * a request that would have succeeded on retry.
 */
export type TtsErrorCode =
  | 'auth'
  | 'concurrency_limited'
  | 'busy'
  | 'rate_limited'
  | 'invalid_input'
  | 'quota_exhausted'
  | 'upstream'
  | 'bad_response';

export class TtsError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

export type Disposition = 'fail_fast' | 'queue_and_wait' | 'retry_with_backoff';

export function dispositionFor(code: TtsErrorCode): Disposition {
  switch (code) {
    case 'concurrency_limited':
      return 'queue_and_wait';
    case 'busy':
    case 'rate_limited':
    case 'upstream':
      return 'retry_with_backoff';
    default:
      return 'fail_fast';
  }
}

/**
 * Backoff with jitter: 1s doubling to a 32s cap, then a random point in [0, delay].
 *
 * Full jitter rather than a fixed fraction. Every request that was refused for the same
 * reason was refused at the same moment, so a deterministic backoff retries them all in
 * lockstep and recreates the overload it was waiting out.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const capped = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 32_000);
  return Math.round(random() * capped);
}

/** The vendor's own error codes, mapped. Documented, never observed. */
function classify(status: number, body: string): TtsErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (/too_many_concurrent_requests/i.test(body)) return 'concurrency_limited';
  if (/system_busy/i.test(body)) return 'busy';
  if (status === 429) return 'rate_limited';
  if (/quota_exceeded|insufficient/i.test(body)) return 'quota_exhausted';
  if (status >= 400 && status < 500) return 'invalid_input';
  return 'upstream';
}

// ═════════════════════════════════════════════════════════════════════════════
// The call
// ═════════════════════════════════════════════════════════════════════════════

export interface SynthesisRequest {
  apiKey: string;
  voiceId: string;
  model: string;
  text: string;
  languageCode?: string;
  /** Up to three, per the vendor's cap. Applied per request. */
  pronunciationLocators?: { pronunciation_dictionary_id: string; version_id: string }[];
  /** Request ids of the chunks immediately before and after, for prosody across a seam. */
  previousRequestIds?: string[];
  nextRequestIds?: string[];
  seed?: number;
  signal?: AbortSignal;
}

export interface SynthesisResult {
  audioBase64: string;
  words: WordTiming[];
  /** Sent as `previousRequestIds` on the next chunk. Without it, seams drift. */
  requestId: string | null;
  charactersBilled: number;
  model: string;
}

/** Three is the vendor's cap, and exceeding it rejects the request rather than truncating. */
const MAX_LOCATORS = 3;

export async function synthesise(req: SynthesisRequest): Promise<SynthesisResult> {
  if ((req.pronunciationLocators?.length ?? 0) > MAX_LOCATORS) {
    throw new TtsError(
      'invalid_input',
      `${req.pronunciationLocators!.length} pronunciation dictionaries requested; the vendor ` +
        `accepts ${MAX_LOCATORS}. Refused here rather than sent, because the vendor rejects ` +
        'the whole request and the resulting error names none of this.',
    );
  }

  // `with-timestamps`, which is the only variant that returns alignment at all. Without it
  // there are no word timings, and without word timings the audio-first ordering has
  // nothing to derive shot durations from.
  const url = `${BASE}/v1/text-to-speech/${encodeURIComponent(req.voiceId)}/with-timestamps`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': req.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        text: req.text,
        model_id: req.model,
        ...(req.languageCode ? { language_code: req.languageCode } : {}),
        ...(req.pronunciationLocators?.length
          ? { pronunciation_dictionary_locators: req.pronunciationLocators }
          : {}),
        ...(req.previousRequestIds?.length
          ? { previous_request_ids: req.previousRequestIds }
          : {}),
        ...(req.nextRequestIds?.length ? { next_request_ids: req.nextRequestIds } : {}),
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
      }),
      signal: req.signal,
    });
  } catch (err) {
    throw new TtsError('upstream', err instanceof Error ? err.message : String(err));
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new TtsError(
      classify(response.status, body),
      `HTTP ${response.status}: ${body.slice(0, 400)}`,
      response.status,
    );
  }

  const parsed = TtsResponseSchema.safeParse(await response.json().catch(() => null));

  if (!parsed.success) {
    // Classified as a bad *response*, not as invalid input. A missing
    // `normalized_alignment` means the timings cannot be trusted, and falling back to the
    // raw `alignment` would put every boundary at the submitted characters rather than the
    // spoken ones — wrong exactly where a dictionary substitution applies.
    throw new TtsError(
      'bad_response',
      `The response did not match the documented shape: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }

  return {
    audioBase64: parsed.data.audio_base64,
    words: wordsFromCharacters(parsed.data.normalized_alignment),
    // Header casing is not guaranteed; `Headers` lookup is case-insensitive.
    requestId: response.headers.get('request-id'),
    // Billed on what was submitted, which is why it is measured here rather than from the
    // normalised text — the vendor charges for the characters it was given.
    charactersBilled: req.text.length,
    model: req.model,
  };
}
