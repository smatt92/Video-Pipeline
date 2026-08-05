'use server';

import { revalidatePath } from 'next/cache';

import { checkEmail } from '../auth/allowed';
import { routeClient } from '../auth/supabase';
import { serverClient, type Db } from '../db/server';
import { INTEGRATION_CATALOG, descriptorFor } from '../drivers/catalog';
import { verifyIntegration } from '../integrations/verify';
import { storeSecret } from '../integrations/vault';
import { isDeferrable } from './gate';
import { integrationForStep } from './step-integration';
import { STEPS } from './steps';

/**
 * The onboarding steps, as Server Actions.
 *
 * ── Client ordering is a hint. This is the rule. ─────────────────────────────
 *
 * The wizard greys out a locked step, and that is a courtesy to the person using it, not a
 * control. Anyone can POST a Server Action directly. So every action below re-derives the
 * dependency graph from the database before doing anything: step 4 asks whether step 2 has
 * passed and refuses if it has not, regardless of what the page showed.
 *
 * That matters beyond tidiness. Step 4 depends on step 2 because a video credential that
 * "passes" before storage works has proven nothing — the clip generates, cannot be written
 * anywhere, and you have paid for it. Enforcing the order only in the UI would make the
 * guarantee cosmetic.
 *
 * ── A failed check advances nothing ──────────────────────────────────────────
 *
 * Progress is appended to `profiles.onboarding_completed_steps` on success and on no other
 * path. No branch below writes progress after a failed probe, and the gate compares that
 * array as a set, so a failure cannot move the app an inch closer to unlocked.
 * `onboarding_step` is derived from the array by a trigger, so it cannot be written past
 * either — 0007 made lying to it impossible rather than merely discouraged.
 */

export interface StepCheck {
  name: string;
  passed: boolean;
  detail: string;
  required: boolean;
}

export interface StepState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  /** Per-check outcomes, for the three-state pill. */
  checks?: StepCheck[];
}

// ═════════════════════════════════════════════════════════════════════════════
// Identity and progress
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The signed-in user, re-checked against the allowlist.
 *
 * Middleware already did this, and doing it again is not redundant. A Server Action is an
 * HTTP endpoint; the matcher covering it today is not a guarantee it covers it tomorrow,
 * and these actions write vendor credentials. Two cheap checks are worth one silent hole.
 */
async function currentUser(): Promise<{ id: string; email: string }> {
  const supabase = await routeClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) throw new Error('Not signed in.');

  const decision = checkEmail(user.email);
  if (!decision.ok) throw new Error('Not permitted.');

  return { id: user.id, email: decision.email };
}

async function completedSteps(db: Db, userId: string): Promise<number[]> {
  const { data } = await db
    .from('profiles')
    .select('onboarding_completed_steps')
    .eq('id', userId)
    .maybeSingle();

  return data?.onboarding_completed_steps ?? [];
}

/**
 * Refuse unless every prerequisite has actually passed.
 *
 * The message names what is missing rather than saying "locked", because someone who
 * reached here by replaying a request has no wizard in front of them to explain it.
 */
async function assertUnlocked(db: Db, userId: string, stepNumber: number): Promise<void> {
  const step = STEPS.find((s) => s.n === stepNumber);
  if (!step) throw new Error(`No such onboarding step: ${stepNumber}`);

  const done = await completedSteps(db, userId);
  const blockers = step.blockedBy.filter((n) => !done.includes(n));

  if (blockers.length > 0) {
    const names = blockers.map((n) => STEPS.find((s) => s.n === n)!.title);
    throw new Error(
      `Step ${stepNumber} (${step.title}) is blocked by ${names.join(' and ')}. ` +
        'The order is not cosmetic — verifying this first would prove nothing.',
    );
  }
}

/**
 * Record a step as passed. Idempotent, and the only writer of progress in the codebase.
 *
 * Reads the array and writes the union rather than appending atomically, which is a race —
 * two concurrent completions could lose one. Single-operator product, one browser tab, and
 * the cost of losing the race is a step that has to be re-run rather than a wrong gate
 * decision. Worth knowing about; not worth a stored procedure today.
 */
async function completeStep(db: Db, userId: string, stepNumber: number): Promise<void> {
  const done = await completedSteps(db, userId);
  if (done.includes(stepNumber)) return;

  // Clear any deferral first. A step cannot be both completed and deferred — 0016 enforces
  // that with a CHECK, so writing the completion without this raises — and beyond the
  // constraint it is the behaviour you want: an integration that now verifies for real
  // must stop being named in the banner as inert.
  const { error: undeferError } = await db.rpc('undefer_onboarding_step', {
    p_profile_id: userId,
    p_step: stepNumber,
  });
  if (undeferError) {
    throw new Error(`Clearing the deferral for step ${stepNumber} failed: ${undeferError.message}`);
  }

  const next = [...done, stepNumber].sort((a, b) => a - b);

  const { error } = await db
    .from('profiles')
    .update({ onboarding_completed_steps: next })
    .eq('id', userId);

  if (error) throw new Error(`Recording step ${stepNumber} failed: ${error.message}`);
}

function fail(err: unknown): StepState {
  return { status: 'error', message: err instanceof Error ? err.message : String(err) };
}

function refresh() {
  revalidatePath('/onboarding', 'layout');
  revalidatePath('/settings', 'layout');
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 1 — Profile
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Writes the profiles row — which is also the row every later step's progress lands on,
 * so nothing else can run before it.
 *
 * The FX rate is the interesting field. Once written it supersedes `USD_INR_RATE` for every
 * rupee figure in the product, and `cost_ledger.usd_inr_rate` snapshots whichever was in
 * force at write time so historical figures stay explainable when it changes.
 */
export async function saveProfile(_prev: StepState, formData: FormData): Promise<StepState> {
  try {
    const user = await currentUser();
    const db = serverClient();

    const displayName = String(formData.get('display_name') ?? '').trim();
    const timezone = String(formData.get('timezone') ?? 'Asia/Kolkata').trim();
    const currency = String(formData.get('currency') ?? 'INR').trim();
    const rateRaw = String(formData.get('usd_inr_rate') ?? '').trim();

    const rate = rateRaw ? Number(rateRaw) : null;
    if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) {
      return { status: 'error', message: 'The USD→INR rate must be a positive number.' };
    }

    const { error } = await db.from('profiles').upsert(
      {
        id: user.id,
        email: user.email,
        display_name: displayName || null,
        timezone,
        currency,
        usd_inr_rate: rate,
      },
      { onConflict: 'id' },
    );

    if (error) throw new Error(error.message);

    await completeStep(db, user.id, 1);
    refresh();

    return {
      status: 'ok',
      message: rate
        ? `Profile saved. ₹${rate} to the dollar is now authoritative over the environment default.`
        : 'Profile saved. No FX rate set, so the environment default still applies.',
    };
  } catch (err) {
    return fail(err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Steps 2–5 — configure a vendor, then prove it
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Store whatever secrets were submitted, then run the real check.
 *
 * Both halves are needed and the order matters. Storing without checking leaves a
 * configured-looking integration nobody has proven; checking without storing cannot test a
 * key that was just typed. Blank fields are skipped rather than cleared — an empty box on a
 * rotation form means "leave this one alone", not "delete my webhook secret".
 *
 * On success the integration is enabled. On failure it is left exactly as it was: a
 * previously-working integration is not disabled because one check failed, because a
 * failure is at least as likely to be a network blip as a bad credential and disabling
 * would take the pipeline down on a transient.
 */
async function writeSecretsAndVerify(
  slug: string,
  formData: FormData,
): Promise<StepState> {
  const db = serverClient();
  const descriptor = descriptorFor(slug);
  if (!descriptor) throw new Error(`Unknown integration "${slug}".`);

  const { data: integration } = await db
    .from('integrations')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (!integration) {
    throw new Error(
      `No integrations row for "${slug}". Migration 0014 creates one per catalogue entry, ` +
        'so this database is behind — run `supabase db push`. (Before 0014 these rows were ' +
        'in seed.sql, which `db push` does not apply; that is what this message used to be ' +
        'about and it sent people looking in the wrong place.)',
    );
  }

  for (const field of descriptor.secretFields) {
    const raw = formData.get(field.key);
    if (typeof raw !== 'string') continue;

    const value = raw.trim();
    if (!value) continue; // blank means "leave it"

    if (field.minLength && value.length < field.minLength) {
      return {
        status: 'error',
        message: `${field.label} must be at least ${field.minLength} characters.`,
      };
    }

    const written = await storeSecret(db, {
      integrationId: integration.id,
      fieldKey: field.key,
      value,
    });

    if (!written.ok) {
      // Nothing is recorded as passed, and the message is the RPC's own — it distinguishes
      // "Vault is not enabled on this project" from "that value was refused", which are
      // twenty minutes apart in how long they take to act on.
      return { status: 'error', message: written.detail };
    }
  }

  const outcome = await verifyIntegration(db, slug);

  // Enabled on success; on failure left exactly as it was. A previously-working
  // integration is not disabled because one check failed — a failure is at least as likely
  // to be a network blip as a bad credential, and disabling would take the pipeline down
  // on a transient.
  if (outcome.ok) {
    await db.from('integrations').update({ is_enabled: true }).eq('id', integration.id);
  }

  refresh();

  return {
    status: outcome.ok ? 'ok' : 'error',
    message: outcome.summary,
    checks: outcome.checks.map((c) => ({
      name: c.name,
      passed: c.passed,
      detail: c.detail,
      required: c.required,
    })),
  };
}

/**
 * A wizard step: dependency check, then configure, then record progress.
 *
 * Both halves of the middle are needed and the order matters. Storing without checking
 * leaves a configured-looking integration nobody has proven; checking without storing
 * cannot test a key that was just typed. Blank fields are skipped rather than cleared — an
 * empty box on a rotation form means "leave this one alone", not "delete my webhook
 * secret".
 */
async function configureAndVerify(stepNumber: number, formData: FormData): Promise<StepState> {
  const user = await currentUser();
  const db = serverClient();

  await assertUnlocked(db, user.id, stepNumber);

  // Resolved by capability, not by name — the wizard asks for "the video generator" and
  // the catalogue answers which vendor that is today.
  const slug = integrationForStep(stepNumber);
  if (!slug) throw new Error(`Step ${stepNumber} configures no integration.`);

  const result = await writeSecretsAndVerify(slug, formData);

  if (result.status === 'ok') {
    await completeStep(db, user.id, stepNumber);
    refresh();
  }

  return result;
}

/** Bound per step by the wizard form. */
export async function runStepCheck(
  stepNumber: number,
  _prev: StepState,
  formData: FormData,
): Promise<StepState> {
  try {
    return await configureAndVerify(stepNumber, formData);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Rotate credentials from the settings screen and re-verify.
 *
 * Deliberately not gated on onboarding order. That gate exists so setup is walked in a
 * sequence that makes each check meaningful; once it has been walked, rotating a leaked key
 * must not require re-completing a wizard.
 */
export async function rotateIntegration(
  slug: string,
  _prev: StepState,
  formData: FormData,
): Promise<StepState> {
  try {
    await currentUser();
    return await writeSecretsAndVerify(slug, formData);
  } catch (err) {
    return fail(err);
  }
}

/** Re-run a vendor check without touching stored credentials. */
export async function recheckIntegration(
  slug: string,
  _prev: StepState,
): Promise<StepState> {
  try {
    await currentUser();
    const db = serverClient();
    const outcome = await verifyIntegration(db, slug);
    refresh();

    return {
      status: outcome.ok ? 'ok' : 'error',
      message: outcome.summary,
      checks: outcome.checks.map((c) => ({
        name: c.name,
        passed: c.passed,
        detail: c.detail,
        required: c.required,
      })),
    };
  } catch (err) {
    return fail(err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 6 — Rate card
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Passes only when every rate an enabled driver actually uses is verified.
 *
 * Addendum 01: *unverified ⇒ no rupee figure anywhere, and submit refuses.* This is where
 * that becomes true rather than aspirational — the step cannot be ticked past, because the
 * condition is read from the database rather than confirmed by a checkbox.
 *
 * "Used by an enabled driver" is doing work. Rates for a vendor nobody enabled are not a
 * blocker: refusing to finish setup over a price for a driver that will never be called is
 * the kind of rule that gets worked around rather than satisfied.
 *
 * The two LLM rows arrive verified from migration 0006 with their source note, because the
 * vendor publishes the number. Every credit- and character-priced rate stays unverified
 * until someone watches a balance move, which is why this step will block on a fresh
 * project — correctly.
 */
export async function confirmRateCard(_prev: StepState): Promise<StepState> {
  try {
    const user = await currentUser();
    const db = serverClient();
    await assertUnlocked(db, user.id, 6);

    const { data: enabled } = await db
      .from('integrations')
      .select('slug')
      .eq('is_enabled', true)
      .not('last_verified_at', 'is', null);

    const enabledSlugs = new Set((enabled ?? []).map((r) => r.slug));

    const needed = INTEGRATION_CATALOG.filter((i) => enabledSlugs.has(i.slug)).flatMap((i) =>
      i.rates.map((r) => ({ driver: i.slug, ...r })),
    );

    if (needed.length === 0) {
      return {
        status: 'error',
        message:
          'No enabled driver declares a priced call yet, so there is nothing to verify. ' +
          'Finish the generation and voice steps first.',
      };
    }

    const { data: rates } = await db
      .from('rate_card')
      .select('driver, model, endpoint, unit, is_verified, unit_cost, source_note');

    const unverified: string[] = [];

    for (const want of needed) {
      const match = (rates ?? []).find(
        (r) =>
          r.driver === want.driver &&
          r.model === want.model &&
          (r.endpoint ?? null) === (want.endpoint ?? null) &&
          r.unit === want.unit,
      );

      if (!match) unverified.push(`${want.driver}/${want.model} per ${want.unit} — no rate card row`);
      else if (!match.is_verified) {
        unverified.push(
          `${want.driver}/${want.model} per ${want.unit} — ${match.source_note ?? 'unverified'}`,
        );
      }
    }

    if (unverified.length > 0) {
      return {
        status: 'error',
        message:
          `${unverified.length} rate${unverified.length === 1 ? '' : 's'} still unverified. ` +
          'Until every one is, no rupee figure renders anywhere and submits refuse — a wrong ' +
          'cost is worse than a missing one because it gets believed.\n\n' +
          unverified.join('\n'),
      };
    }

    await completeStep(db, user.id, 6);
    refresh();

    return {
      status: 'ok',
      message: `All ${needed.length} rates used by enabled drivers are verified.`,
    };
  } catch (err) {
    return fail(err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Step 8 — First channel
// ═════════════════════════════════════════════════════════════════════════════

/** Concepts cannot exist without a channel — `concepts.channel_id` is NOT NULL. */
export async function createChannel(_prev: StepState, formData: FormData): Promise<StepState> {
  try {
    const user = await currentUser();
    const db = serverClient();
    await assertUnlocked(db, user.id, 8);

    const name = String(formData.get('name') ?? '').trim();
    const platform = String(formData.get('platform') ?? '').trim();
    const niche = String(formData.get('niche') ?? '').trim();
    const handle = String(formData.get('handle') ?? '').trim();

    if (!name || !platform || !niche) {
      return { status: 'error', message: 'Name, platform and niche are all required.' };
    }

    const { data, error } = await db
      .from('channels')
      .insert({ name, platform, niche, handle: handle || null, is_active: true })
      .select('id, name')
      .single();

    if (error || !data) throw new Error(error?.message ?? 'Channel insert returned nothing.');

    await completeStep(db, user.id, 8);
    refresh();

    return { status: 'ok', message: `Channel "${data.name}" created.` };
  } catch (err) {
    return fail(err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Credit purchases — the expiry clock, entered by hand
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Record a credit purchase.
 *
 * Manual because the vendor gives us nothing to read: the SDK has no account surface, and
 * guessing an undocumented REST path to report a confident-looking balance is worse than
 * asking. Same shape as the rate card — a number only the account holder can see.
 *
 * One row per purchase, because credits expire per purchase. Two top-ups are two clocks
 * running at once, and a single "credits purchased" field is wrong the second time anyone
 * buys any.
 *
 * `amount_usd` is optional and worth filling in: credits ÷ dollars is the only route to a
 * verified per-credit rate, and a verified rate is what unblocks onboarding step 6.
 */
export async function recordCreditPurchase(
  slug: string,
  _prev: StepState,
  formData: FormData,
): Promise<StepState> {
  try {
    await currentUser();
    const db = serverClient();

    const credits = Number(String(formData.get('credits') ?? '').trim());
    const purchasedAt = String(formData.get('purchased_at') ?? '').trim();
    const expiryDays = Number(String(formData.get('expiry_days') ?? '90').trim());
    const amountRaw = String(formData.get('amount_usd') ?? '').trim();
    const note = String(formData.get('note') ?? '').trim();

    if (!Number.isFinite(credits) || credits <= 0) {
      return { status: 'error', message: 'Credits must be a positive number.' };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(purchasedAt)) {
      return { status: 'error', message: 'Purchase date must be a date.' };
    }
    if (!Number.isFinite(expiryDays) || expiryDays <= 0) {
      return { status: 'error', message: 'Expiry window must be a positive number of days.' };
    }

    const amount = amountRaw ? Number(amountRaw) : null;
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      return { status: 'error', message: 'Amount must be a number.' };
    }

    const { data: integration } = await db
      .from('integrations')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (!integration) throw new Error(`No integrations row for "${slug}".`);

    const { data, error } = await db
      .from('credit_purchases')
      .insert({
        integration_id: integration.id,
        credits,
        purchased_at: purchasedAt,
        expiry_days: expiryDays,
        amount_usd: amount,
        note: note || null,
      })
      .select('expires_at')
      .single();

    if (error || !data) throw new Error(error?.message ?? 'Insert returned nothing.');

    refresh();

    // `expires_at` is a generated column and cannot be null, but the generated types mark
    // every generated column nullable. Read defensively rather than asserted — the whole
    // point of the column is that the date is right.
    const expiresAt = data.expires_at;
    if (!expiresAt) {
      return { status: 'ok', message: `${credits} credits recorded.` };
    }

    const days = Math.round((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);

    return {
      status: 'ok',
      message: `${credits} credits recorded. They expire ${expiresAt} — ${days} days from today.`,
    };
  } catch (err) {
    return fail(err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Concurrency override
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Set the parallel-request ceiling by hand.
 *
 * Exists because the plan-tier read is informational and may simply not work — the
 * subscription endpoint is documented but unproven here. When it does not, the ceiling
 * falls back to a deliberately low default, and someone who knows the real limit should be
 * able to say so without waiting for a probe to start working.
 *
 * Recorded as `manual`, which is not cosmetic: `verifyIntegration` refuses to overwrite a
 * manual value with a probe result. A person who read their real limit off an invoice knows
 * more than a fallback does, and a re-run of the check should not quietly undo them.
 */
export async function setConcurrency(
  slug: string,
  _prev: StepState,
  formData: FormData,
): Promise<StepState> {
  try {
    await currentUser();
    const db = serverClient();

    const raw = String(formData.get('concurrency_limit') ?? '').trim();

    // Blank clears the override and hands the field back to the probe.
    if (!raw) {
      const { error } = await db
        .from('integrations')
        .update({ concurrency_limit: null, concurrency_source: 'default' })
        .eq('slug', slug);
      if (error) throw new Error(error.message);
      refresh();
      return {
        status: 'ok',
        message: 'Override cleared. The next check will set this from the account, or fall back to the safe default.',
      };
    }

    const limit = Number(raw);
    if (!Number.isInteger(limit) || limit < 1) {
      return { status: 'error', message: 'Concurrency must be a whole number of at least 1.' };
    }

    const { error } = await db
      .from('integrations')
      .update({ concurrency_limit: limit, concurrency_source: 'manual' })
      .eq('slug', slug);

    if (error) throw new Error(error.message);
    refresh();

    return {
      status: 'ok',
      message: `Ceiling set to ${limit} parallel requests, recorded as manual. A check re-run will not overwrite it.`,
    };
  } catch (err) {
    return fail(err);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Deferral — the third state
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Record a step as deliberately skipped.
 *
 * Not a pass. `completeStep` is never called, `onboarding_completed_steps` is untouched,
 * and the integration the step configures stays unverified — so `usability()` still says
 * unusable and every pipeline task still refuses. What changes is the gate, and only the gate.
 *
 * The reason is required and enforced in SQL rather than here, because a deferral without
 * one cannot be told apart from a step somebody forgot, and the banner that names it would
 * have nothing to say.
 *
 * Only steps 4 and 5 may be deferred. Deferring storage or the LLM would produce an app in
 * which nothing works at all, and a gate that can be waved through entirely is not a gate.
 */
export async function deferStep(
  stepNumber: number,
  _prev: StepState,
  formData: FormData,
): Promise<StepState> {
  try {
    const user = await currentUser();
    const db = serverClient();

    if (!isDeferrable(stepNumber)) {
      const step = STEPS.find((s) => s.n === stepNumber);
      return {
        status: 'error',
        message:
          `Step ${stepNumber}${step ? ` (${step.title})` : ''} cannot be deferred. Only the ` +
          'steps whose vendors gate API access behind a paid plan can be, because those are ' +
          'the ones you can do everything right and still not have. Storage and the LLM are ' +
          'not among them — without either, there is no app to be let into.',
      };
    }

    const reason = String(formData.get('reason') ?? '').trim();
    if (reason.length < 3) {
      return {
        status: 'error',
        message:
          'Say why. A deferral with no reason is indistinguishable from a step you forgot, ' +
          'and this text is what the banner shows you in a week when you have forgotten.',
      };
    }

    const { error } = await db.rpc('defer_onboarding_step', {
      p_profile_id: user.id,
      p_step: stepNumber,
      p_reason: reason,
    });

    if (error) throw new Error(error.message);

    refresh();
    revalidatePath('/', 'layout');

    const step = STEPS.find((s) => s.n === stepNumber);
    return {
      status: 'ok',
      message:
        `Step ${stepNumber}${step ? ` (${step.title})` : ''} deferred. The app is now ` +
        'reachable. Nothing that needs this integration will run — every task that reaches ' +
        'for it refuses with the reason you just gave, and every screen that would have ' +
        'shown its data says so instead.',
    };
  } catch (err) {
    return fail(err);
  }
}

/** Clear a deferral. Called on a real pass, and available on its own. */
export async function undeferStep(stepNumber: number): Promise<StepState> {
  try {
    const user = await currentUser();
    const db = serverClient();

    const { error } = await db.rpc('undefer_onboarding_step', {
      p_profile_id: user.id,
      p_step: stepNumber,
    });
    if (error) throw new Error(error.message);

    refresh();
    revalidatePath('/', 'layout');
    return { status: 'ok', message: `Step ${stepNumber} is no longer deferred.` };
  } catch (err) {
    return fail(err);
  }
}
