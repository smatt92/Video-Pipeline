import 'server-only';

import { descriptorFor, type OnboardingRole } from '../drivers/catalog';
import { serverClient } from '../db/server';
import { STEPS } from './steps';
import { STEP_ROLE, integrationForStep } from './step-integration';

/**
 * What is deferred, and what is inert because of it.
 *
 * One read, shared by the banner and by every empty state that has to explain itself. The
 * alternative — each screen deriving "is the video driver deferred?" for itself — is four
 * copies of one rule, and the day they disagree the app tells you two different stories
 * about the same integration.
 *
 * `roles` is what the screens key off: a screen asks "is the generation role deferred?", never
 * "is <that vendor> deferred?". Same reason `catalog.ts` exists — the vendor filling a
 * role is a config value, and a component that names one is the rule-1 violation this
 * project keeps catching. It caught this very comment, which named one while explaining
 * why not to; the check does not care that the mention was rhetorical, and it is right
 * not to — a grep cannot tell irony from a hardcoded string, and neither can the next
 * person who copies the line.
 */

export interface DeferredIntegration {
  step: number;
  stepTitle: string;
  reason: string;
  at: string | null;
  /** Present when the step maps to an integration; absent for a step that configures none. */
  slug: string | null;
  label: string | null;
  /**
   * The role the step configures (`STEP_ROLE`). Roles rather than catalogue kinds since
   * 0015: one integration fills both generation and voice, and embeddings is a role no kind
   * describes, so keying off `kind` made the voice note unreachable and showed an embeddings
   * deferral as the video one.
   */
  role: OnboardingRole | null;
}

export interface DeferralState {
  any: boolean;
  items: DeferredIntegration[];
  /** Roles with no usable integration because the step configuring them was deferred. */
  roles: Set<OnboardingRole>;
  /** Set when the read itself failed — never silently "nothing is deferred". */
  unavailable: string | null;
}

const NONE: DeferralState = { any: false, items: [], roles: new Set(), unavailable: null };

export async function deferralState(): Promise<DeferralState> {
  try {
    const db = serverClient();
    const { data, error } = await db
      .from('v_deferred_steps')
      .select('step, reason, deferred_at')
      .order('step');

    if (error) {
      // A missing view means migration 0016 has not been applied. Reporting that is more
      // useful than reporting "nothing deferred", which would be indistinguishable from a
      // fully configured install and would quietly drop every warning on every screen.
      return { ...NONE, unavailable: error.message };
    }

    const items: DeferredIntegration[] = (data ?? [])
      .filter((d): d is typeof d & { step: number } => d.step !== null)
      .map((d) => {
        const slug = integrationForStep(d.step);
        const descriptor = slug ? descriptorFor(slug) : null;
        return {
          step: d.step,
          stepTitle: STEPS.find((s) => s.n === d.step)?.title ?? `Step ${d.step}`,
          reason: d.reason ?? 'no reason recorded',
          at: d.deferred_at,
          slug,
          label: descriptor?.label ?? null,
          role: STEP_ROLE[d.step] ?? null,
        };
      });

    return {
      any: items.length > 0,
      items,
      roles: new Set(items.map((i) => i.role).filter((r): r is OnboardingRole => r !== null)),
      unavailable: null,
    };
  } catch (err) {
    return { ...NONE, unavailable: err instanceof Error ? err.message : String(err) };
  }
}

/** One sentence naming what a screen cannot show, for an empty state. */
export function inertBecause(state: DeferralState, role: OnboardingRole): string | null {
  const item = state.items.find((i) => i.role === role);
  if (!item) return null;
  return (
    `${item.label ?? item.stepTitle} was deferred${item.at ? ` on ${item.at.slice(0, 10)}` : ''}: ` +
    `"${item.reason}". Nothing here will fill in until onboarding step ${item.step} is finished.`
  );
}
