import Anthropic from '@anthropic-ai/sdk';
import { HiggsfieldClient } from '@higgsfield/client';

import type { IntegrationDescriptor } from './catalog';

/**
 * Credential probes — the cheapest authenticated call each vendor offers.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 *
 * Not a driver implementation. There is no `submit`, no `status`, no `cancel`, and nothing
 * here generates anything or spends a credit. `VideoDriver` and `AudioDriver` in `types.ts`
 * remain unimplemented and are Gate 2's business.
 *
 * This exists because onboarding requires that *every step verifies with a real call, not
 * a format check* — a regex that confirms a key starts with the right prefix tells you the
 * key is shaped like a key. The narrowest thing that answers "does this credential work?"
 * is one authenticated read, so that is all that is here.
 *
 * ── Required versus informational ────────────────────────────────────────────
 *
 * A probe returns a list of check results, and they are not equal. `credentials` decides
 * whether the integration is usable. Everything else is worth knowing and must not gate
 * anything — the credit-balance read in particular, because the vendor SDK does not expose
 * a balance endpoint and nothing is served by blocking setup on a number we cannot get.
 * Saying so on screen is better than either failing the step or pretending the clock is
 * being watched.
 */

export interface CheckResult {
  name: 'credentials' | 'round_trip' | 'balance' | 'voices' | 'models';
  passed: boolean;
  /** Shown to the user. Must never contain credential material. */
  detail: string;
  /** False = informational. A failure here does not make the integration unusable. */
  required: boolean;
  /** Non-secret facts worth storing on `integrations.config`. */
  config?: Record<string, unknown>;
}

export interface ProbeResult {
  checks: CheckResult[];
  latencyMs: number;
}

/** A probe never throws. An exception here would be a failed check that took the page with it. */
function failure(
  name: CheckResult['name'],
  err: unknown,
  required = true,
): CheckResult {
  const message = err instanceof Error ? err.message : String(err);
  return { name, passed: false, detail: redact(message), required };
}

/**
 * Error messages from vendor SDKs sometimes echo the request, and the request carried the
 * key. Anything long and key-shaped is removed before this reaches a screen or a database
 * row — `integration_events.detail` is an audit trail, and an audit trail holding the
 * credential it was auditing is worse than no audit trail.
 */
function redact(s: string): string {
  return s
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|xi-[A-Za-z0-9_-]{8,})\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .slice(0, 500);
}

// ═════════════════════════════════════════════════════════════════════════════
// LLM
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `models.list()` — authenticated, returns immediately, and costs nothing because no
 * tokens are generated. A one-token Messages call would also work and would appear on the
 * bill, which is a poor way to begin a setup wizard.
 */
export async function probeLlm(apiKey: string): Promise<ProbeResult> {
  const started = Date.now();
  const checks: CheckResult[] = [];

  try {
    const client = new Anthropic({ apiKey });
    const models = await client.models.list({ limit: 20 });
    const ids = models.data.map((m) => m.id);

    checks.push({
      name: 'credentials',
      passed: true,
      detail: 'Authenticated against the models endpoint.',
      required: true,
    });
    checks.push({
      name: 'models',
      passed: ids.length > 0,
      detail: ids.length ? `${ids.length} models available.` : 'The account has no models.',
      required: false,
      // Stored so the generation settings can offer real choices rather than a hardcoded
      // list that drifts as models rotate.
      config: { models: ids, models_read_at: new Date().toISOString() },
    });
  } catch (err) {
    checks.push(failure('credentials', err));
  }

  return { checks, latencyMs: Date.now() - started };
}

// ═════════════════════════════════════════════════════════════════════════════
// Video
// ═════════════════════════════════════════════════════════════════════════════

/**
 * `getMotions()` — the cheapest authenticated read the SDK exposes. It returns the motion
 * catalogue, which is also the thing shot recipes are built from, so a working credential
 * and a usable motion list are established in one call.
 *
 * **The credit balance is not read, because the SDK does not expose it.** The v2 client
 * offers generate, soul-id, upload, motions and styles — no account or balance surface at
 * all. Rather than guess an undocumented REST path and report a confident-looking number
 * from it, this returns a failed *informational* check saying the balance is unreadable.
 * Credits expire on a roughly 90-day clock and that clock matters; a screen that claims to
 * be watching it while reading nothing is worse than one that admits it cannot.
 */
export async function probeVideo(creds: {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
}): Promise<ProbeResult> {
  const started = Date.now();
  const checks: CheckResult[] = [];

  try {
    const client = new HiggsfieldClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      // `baseURL`, capital URL — the SDK's spelling. A `baseUrl` key is silently ignored
      // and the client quietly talks to the default host.
      ...(creds.baseUrl ? { baseURL: creds.baseUrl } : {}),
    });

    const motions = await client.getMotions();
    client.close();

    checks.push({
      name: 'credentials',
      passed: true,
      detail: `Authenticated. ${motions.length} motions available.`,
      required: true,
      config: {
        motion_count: motions.length,
        motions_read_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    checks.push(failure('credentials', err));
  }

  checks.push({
    name: 'balance',
    passed: false,
    required: false,
    detail:
      'Not readable. The vendor SDK exposes no account or balance endpoint, and this ' +
      'refuses to guess an undocumented path and report the result as a real figure. ' +
      'Credits expire roughly 90 days from purchase — note the date somewhere you will ' +
      'see it, because nothing here is watching that clock.',
  });

  return { checks, latencyMs: Date.now() - started };
}

// ═════════════════════════════════════════════════════════════════════════════
// Audio
// ═════════════════════════════════════════════════════════════════════════════

const ELEVENLABS_BASE = 'https://api.elevenlabs.io';

/**
 * Two reads: the voice list, and the subscription tier.
 *
 * The tier is the point. It decides the parallel-request ceiling the queue obeys at run
 * time, and a hardcoded number above the real limit produces a steady failure rate that
 * reads as vendor flakiness rather than as a configuration error. `PLAN_TIERS` in
 * `catalog.ts` maps a tier name to its concurrency, and the resolved number is stored on
 * the integration so the queue reads it rather than guessing.
 *
 * Plain `fetch` rather than an SDK because no SDK for this vendor is a dependency, and
 * adding one to make two GETs would be a poor trade. **These two paths have never been
 * called from this codebase** — the host is refused by the build environment's egress
 * policy. They are read from the vendor's documentation, which is exactly the kind of
 * assumption CLAUDE.md rule 8 says is not yet done.
 */
export async function probeAudio(creds: { apiKey: string }): Promise<ProbeResult> {
  const started = Date.now();
  const checks: CheckResult[] = [];
  const headers = { 'xi-api-key': creds.apiKey, accept: 'application/json' };

  let voiceCount: number | null = null;

  try {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/voices`, { headers });
    if (!res.ok) throw new Error(`voices returned HTTP ${res.status}`);

    const body: unknown = await res.json();
    const voices =
      typeof body === 'object' && body !== null && 'voices' in body && Array.isArray(body.voices)
        ? body.voices
        : [];
    voiceCount = voices.length;

    checks.push({
      name: 'credentials',
      passed: true,
      detail: `Authenticated. ${voiceCount} voices available.`,
      required: true,
    });
  } catch (err) {
    checks.push(failure('credentials', err));
    return { checks, latencyMs: Date.now() - started };
  }

  try {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/user/subscription`, { headers });
    if (!res.ok) throw new Error(`subscription returned HTTP ${res.status}`);

    const body: unknown = await res.json();
    const tier =
      typeof body === 'object' && body !== null && 'tier' in body && typeof body.tier === 'string'
        ? body.tier
        : null;

    checks.push({
      name: 'voices',
      passed: tier !== null,
      required: true,
      detail: tier
        ? `Plan tier "${tier}". ${voiceCount} voices.`
        : 'The subscription response carried no tier, so the concurrency ceiling is unknown.',
      config: tier
        ? { plan_tier: tier, voice_count: voiceCount, tier_read_at: new Date().toISOString() }
        : undefined,
    });
  } catch (err) {
    // Required: without a tier the queue has no ceiling to obey, and inventing one is how
    // a constant failure rate gets mistaken for an unreliable vendor.
    checks.push(failure('voices', err));
  }

  return { checks, latencyMs: Date.now() - started };
}

// ═════════════════════════════════════════════════════════════════════════════
// Dispatch
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Route a descriptor to its probe.
 *
 * This lives here, inside the driver layer, because it is the only place allowed to know
 * which vendor is behind which slug. The first version of it was a `switch (slug)` in
 * `src/lib/integrations/verify.ts` and the vendor-isolation check refused it — correctly.
 * The rule's message is that the fix is almost never to move the string somewhere quieter:
 * the caller needed "run this integration's credential probe" and had no way to ask for
 * it, so it asked "is this vendor Higgsfield?" instead.
 *
 * Returns `null` for descriptors this module does not probe. Storage is the case: its
 * probe is a property of the `StorageDriver` interface — write, read back, delete — and
 * duplicating it here would be a second implementation to drift.
 */
export async function probeIntegration(
  descriptor: IntegrationDescriptor,
  values: Record<string, string>,
): Promise<ProbeResult | null> {
  switch (descriptor.slug) {
    case 'anthropic':
      return probeLlm(values.ANTHROPIC_API_KEY);

    case 'higgsfield':
      return probeVideo({
        apiKey: values.HIGGSFIELD_API_KEY,
        apiSecret: values.HIGGSFIELD_API_SECRET,
        baseUrl: process.env.HIGGSFIELD_API_BASE_URL || undefined,
      });

    case 'elevenlabs':
      return probeAudio({ apiKey: values.ELEVENLABS_API_KEY });

    case 'fal':
      // Declared in the catalogue and deliberately without a probe. The second video
      // driver exists to keep the interface honest and is not on the critical path; a
      // probe written against an API nobody here has called would be a guess wearing a
      // tick.
      return {
        latencyMs: 0,
        checks: [
          {
            name: 'credentials',
            passed: false,
            required: true,
            detail: 'No probe implemented for this vendor yet.',
          },
        ],
      };

    default:
      return null;
  }
}
