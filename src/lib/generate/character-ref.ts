/**
 * Why a shot carrying a character reference cannot be generated.
 *
 * One reason, in one place, because two stages ask the same question and both used to
 * answer it wrongly in the same way.
 *
 * `compile.ts` refuses a shot when no recipe of its kind is marked `accepts_character_ref`,
 * saying the alternatives "would drop the reference and generate a different-looking
 * person". `submit.ts` refused on the same boolean with the same warning. **Both accepting
 * branches then dropped the reference too**: nothing in `src/` reads the `characters`
 * table, and neither the compiled params nor the submit payload has ever carried a
 * reference field.
 *
 * So each guard let through exactly the outcome its own message named, while reading as
 * protection. `accepts_character_ref` describes a recipe's capability, which is a real and
 * useful fact — it just never had anything to carry.
 *
 * Sharing the predicate is the point rather than a tidy-up: the two guards drifted into the
 * same wrong shape independently, and one of them being fixed left the other still claiming
 * a protection it did not provide.
 */

export const CHARACTER_REF_UNSUPPORTED =
  'this shot carries a character reference and nothing passes one to the vendor yet — ' +
  '`characters` has no reader anywhere in src/, and neither the compiled parameters nor the ' +
  'submit payload carries a reference field. Generating would produce a different-looking ' +
  'person and bill for it, which is what `accepts_character_ref` reads as preventing.';

/**
 * True while no code path passes a character reference.
 *
 * A constant rather than a probe, and deliberately: the probe form would ask "has anything
 * ever passed one", which is unanswerable from rows — a reference is a request field, not a
 * record. `verify:submit` §3 asserts the refusal in both directions instead, so the day a
 * reference is passed the harness fails and this constant has to go with it.
 */
export const CHARACTER_REF_IS_PASSED = false;
