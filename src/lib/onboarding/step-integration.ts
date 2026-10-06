import { ROLE_INTEGRATION, type OnboardingRole } from '../drivers/catalog';

/**
 * Which *role* each wizard step configures.
 *
 * Roles, not slugs. The vendor-isolation check caught the first version of this file
 * mapping step 4 to a vendor name, and the rule's own message is right about the fix: the
 * problem was not the string's location, it was that the wizard was asking the wrong
 * question. Step 4 does not configure a particular vendor, it configures *the generator* —
 * which vendor fills that role is a catalogue row (ARCHITECTURE.md §0.1: the generator is a
 * config value, and the loop is the durable asset).
 *
 * Roles rather than catalogue kinds since decision 0015: one vendor now fills generation AND
 * voice, and embeddings are a role no kind describes. Steps 4 and 5 therefore resolve to the
 * same integration — verifying the key once satisfies both, which is the point of one vendor.
 *
 * Its own module rather than living in `actions.ts` because that file is `'use server'`,
 * where every export must be an async function — a plain lookup table exported from there
 * is a build error.
 */
export const STEP_ROLE: Readonly<Record<number, OnboardingRole>> = {
  2: 'storage',
  3: 'llm',
  4: 'generation',
  5: 'voice',
  11: 'embeddings',
};

/** The slug of the vendor currently filling the role this step configures. */
export function integrationForStep(stepNumber: number): string | null {
  const role = STEP_ROLE[stepNumber];
  return role ? ROLE_INTEGRATION[role] : null;
}
