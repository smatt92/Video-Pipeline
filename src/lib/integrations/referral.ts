import 'server-only';

import { randomBytes } from 'node:crypto';

import type { Db } from '../db/server';

/**
 * Referral attribution on the connect flow.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this is worth an afternoon before it is worth anything
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Whether a vendor account was created *through* Kiln is only observable at the moment
 * somebody clicks through to make it. Afterwards neither side can recover it: the vendor
 * sees a signup, we see a credential, and nothing connects them. So the cost of capturing
 * it is one afternoon now and infinity later, which is a trade with only one answer.
 *
 * ── Null means "we do not know", and stays that way ──────────────────────────
 *
 * An integration with no referral code is either an account that predates this flow or one
 * created directly. Those are indistinguishable and the code does not guess between them —
 * a partnership conversation is precisely where an attribution claim that cannot be
 * evidenced does damage, because it is the one place somebody will check.
 */

/** Where the click came from. `refusal` is the highest-intent path in the product. */
export type ReferralSource = 'onboarding' | 'settings' | 'refusal';

/**
 * The code sent to the vendor, and stored alongside the integration.
 *
 * Random rather than derived from anything about the workspace. A code containing an email
 * hash or a profile id is a personal identifier handed to a third party, and the only thing
 * this needs to do is match on both sides later.
 */
export function mintReferralCode(): string {
  return `kiln-${randomBytes(9).toString('base64url')}`;
}

/**
 * Build the vendor's signup URL with the code attached, and record it.
 *
 * Recorded *before* the redirect, deliberately: the person is about to leave and may never
 * come back, and an attribution written on their return would miss exactly the signups that
 * did not convert — which is the denominator any honest conversion figure needs.
 */
export async function beginReferral(
  db: Db,
  params: { slug: string; signupUrl: string; source: ReferralSource },
): Promise<{ url: string; code: string } | { url: string; code: null; reason: string }> {
  const code = mintReferralCode();

  const { data: existing } = await db
    .from('integrations')
    .select('id, referral_code')
    .eq('slug', params.slug)
    .maybeSingle();

  if (!existing) {
    // No row to attribute against. The link still works — refusing to open it because we
    // cannot count it would be letting the measurement block the thing being measured.
    return { url: params.signupUrl, code: null, reason: `No integrations row for "${params.slug}".` };
  }

  // Never overwritten. A second click is the same person going back for the link, not a
  // second signup, and replacing the code would silently re-date an attribution.
  if (existing.referral_code) {
    return withCode(params.signupUrl, existing.referral_code, existing.referral_code);
  }

  const { error } = await db
    .from('integrations')
    .update({
      referral_code: code,
      referral_source: params.source,
      referred_at: new Date().toISOString(),
    })
    .eq('id', existing.id);

  if (error) {
    return { url: params.signupUrl, code: null, reason: error.message };
  }

  return withCode(params.signupUrl, code, code);
}

function withCode(signupUrl: string, code: string, returned: string) {
  const url = new URL(signupUrl);
  url.searchParams.set('ref', code);
  return { url: url.toString(), code: returned };
}

export interface RollupRow {
  period: string;
  driver: string;
  unit: string;
  unitsConsumed: number;
  costInr: number;
  generations: number;
  rendersCompleted: number;
}

/**
 * The anonymised aggregate.
 *
 * Reads the view rather than the ledger, so the anonymisation is in the schema rather than
 * in this function's discipline. Nothing here can accidentally select a concept title
 * because the view has no column that holds one.
 */
export async function readPartnerRollup(db: Db): Promise<RollupRow[]> {
  const { data } = await db
    .from('v_partner_rollup')
    .select('period, driver, unit, units_consumed, cost_inr, generations, renders_completed')
    .order('period', { ascending: false });

  return (data ?? []).map((r) => ({
    period: String(r.period),
    driver: String(r.driver),
    unit: String(r.unit),
    unitsConsumed: Number(r.units_consumed ?? 0),
    costInr: Number(r.cost_inr ?? 0),
    generations: Number(r.generations ?? 0),
    rendersCompleted: Number(r.renders_completed ?? 0),
  }));
}
