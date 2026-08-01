import { primaryForKind, type IntegrationKindSlug } from '../drivers/catalog';

/**
 * Which *kind* of integration each wizard step configures.
 *
 * Kinds, not slugs. The vendor-isolation check caught the first version of this file
 * mapping step 4 to a vendor name, and the rule's own message is right about the fix: the
 * problem was not the string's location, it was that the wizard was asking the wrong
 * question. Step 4 does not configure a particular vendor, it configures *the video
 * generator* — which vendor fills that role is a catalogue row (ARCHITECTURE.md §0.1: the
 * generator is a config value, and the loop is the durable asset).
 *
 * The practical consequence: swapping the video driver is one edit in `catalog.ts` and
 * touches neither the wizard nor the actions.
 *
 * Its own module rather than living in `actions.ts` because that file is `'use server'`,
 * where every export must be an async function — a plain lookup table exported from there
 * is a build error.
 */
export const STEP_KIND: Readonly<Record<number, IntegrationKindSlug>> = {
  2: 'storage',
  3: 'llm',
  4: 'video',
  5: 'audio',
};

/** The slug of the vendor currently filling the role this step configures. */
export function integrationForStep(stepNumber: number): string | null {
  const kind = STEP_KIND[stepNumber];
  return kind ? (primaryForKind(kind)?.slug ?? null) : null;
}
