/**
 * What kind of shot this is — the categorical signal a recipe is selected on.
 *
 * ── Why this had to exist before the library was useful ──────────────────────
 *
 * `compileShot` selected "the first entry for this driver, highest version", which was
 * honest while the library was empty and becomes nonsense the moment it is not: all six
 * shots of a video would compile to the same recipe. A recipe is a *camera*, and a
 * six-shot video that is six identical camera moves is the slideshow the shotlist prompt
 * explicitly tells the model to avoid.
 *
 * So a shot has to say what it needs, and a recipe has to say what it serves. This is that
 * vocabulary, and both sides speak it: `shots.shot_kind`, and `prompts.tags`.
 *
 * ── Closed, editorial, and vendor-neutral ────────────────────────────────────
 *
 * Closed because an open vocabulary stops matching within a month — "product macro",
 * "macro product", "close product" are three tags and one idea, and a lookup across them
 * silently returns nothing.
 *
 * Editorial rather than technical: these describe what the frame *is*, not how a vendor
 * makes it. No motion names, no model names, no aspect ratios. That keeps this file out of
 * the driver layer, and it means a recipe library for a second vendor is a set of new
 * `prompts` rows rather than a new vocabulary (ARCHITECTURE.md §0.1 — the generator is a
 * config value).
 *
 * Small on purpose. Seven kinds is enough to select between and few enough that a person
 * can hold them, and each one is a genuinely different generation problem — a static macro
 * and a moving crowd fail in different ways and want different parameters.
 */

export interface ShotKindDescriptor {
  readonly key: string;
  readonly label: string;
  /** Shown to the shotlist model. Written so the choice is obvious from the frame. */
  readonly forModel: string;
  /** Shown in the library UI, for someone deciding what to go and discover. */
  readonly note: string;
}

export const SHOT_KINDS: readonly ShotKindDescriptor[] = [
  {
    key: 'establishing',
    label: 'Establishing',
    forModel:
      'A wide frame that sets a place or situation. Little or no movement. Used to open, ' +
      'or to reset after a tight sequence.',
    note: 'Usually the cheapest to get right and the easiest to reuse across videos.',
  },
  {
    key: 'subject_medium',
    label: 'Subject, medium',
    forModel:
      'A person or animal at medium distance, doing something ordinary. The subject is the ' +
      'point of the frame.',
    note: 'The hardest kind for consistency across shots — this is where character reference images earn their keep.',
  },
  {
    key: 'detail_macro',
    label: 'Detail / macro',
    forModel:
      'A close frame on an object, a hand, a surface. Shallow focus. Nothing else in shot.',
    note: 'Most reliable kind on most models. Good default when a shot could go either way.',
  },
  {
    key: 'action_insert',
    label: 'Action insert',
    forModel:
      'A short, fast frame with distinct movement — something falls, slaps down, snaps ' +
      'shut. Cut in for rhythm rather than information.',
    note: 'Short durations, and worth its own recipe: a motion tuned for a two-second beat is not the one tuned for six.',
  },
  {
    key: 'environment_move',
    label: 'Environment, moving camera',
    forModel:
      'The camera travels through or across a space — a push, a drift, a rise. The subject ' +
      'is the movement itself.',
    note: 'The kind most likely to produce warping artifacts. Expect a lower hit rate and price accordingly.',
  },
  {
    key: 'abstract',
    label: 'Abstract / texture',
    forModel:
      'No recognisable subject. Light, texture, particles, ink, smoke. Used under a line ' +
      'that needs a frame but not an illustration.',
    note: 'Very high hit rate, and the safest filler when a literal frame would be wrong or risky.',
  },
  {
    key: 'graphic_plate',
    label: 'Graphic plate',
    forModel:
      'A deliberately simple, near-static frame intended to sit under text added later — ' +
      'a gradient, a clean surface, a shallow field of colour.',
    note: 'Text is added at assembly, never generated. This is the plate it goes on.',
  },
] as const;

export const SHOT_KIND_KEYS = SHOT_KINDS.map((k) => k.key);

export function shotKind(key: string): ShotKindDescriptor | undefined {
  return SHOT_KINDS.find((k) => k.key === key);
}

/** The vocabulary as the shotlist prompt presents it. */
export function shotKindMenu(): string {
  return SHOT_KINDS.map((k) => `- ${k.key}: ${k.forModel}`).join('\n');
}
