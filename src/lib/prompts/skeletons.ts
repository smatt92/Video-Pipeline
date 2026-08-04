/**
 * Fixed-slot template skeletons.
 *
 * ── What these are, and firmly what they are not ─────────────────────────────
 *
 * **Not recipes.** Nothing here has been run against our driver, nothing has a sample
 * output, and nothing has a `params` blob. Persisting any of it to the `prompts` table
 * would be exactly the failure the library exists to prevent: production reads the library
 * precisely because every row in it is a thing that was watched and judged good.
 *
 * A skeleton is the *shape* of a prompt — which slots to fill, in which order — extracted
 * from prompts that demonstrably produce a coherent image on some model somewhere. It is an
 * authoring aid for the Studio lane and for MCP exploration. The route from here to the
 * library is unchanged and has one step in it: run it, watch the clip, then
 * `save_prompt_recipe` with the exact parameters it was proven with.
 *
 * ── Why a fixed-slot shape at all ────────────────────────────────────────────
 *
 * Freeform prose degrades unevenly. A description that happens to mention background and
 * mood produces a different class of image from one that does not, and neither the author
 * nor the reviewer can see which happened — the prompt reads fine either way. Named slots
 * make an omission visible as an empty slot rather than as an image that is subtly flatter
 * than the last one.
 *
 * This matters most for `graphic_plate` and `detail_macro`, the two shot kinds where the
 * subject is a designed surface rather than a scene: there is no world to fall back on, so
 * anything the prompt does not say is invented.
 */

export interface Skeleton {
  readonly key: string;
  readonly label: string;
  /** Shot kinds this shape suits. Matches the closed vocabulary in `shots/kinds.ts`. */
  readonly shotKinds: readonly string[];
  readonly slots: readonly { readonly name: string; readonly asks: string }[];
  /** Where the shape came from, so a reader can judge it. */
  readonly provenance: string;
  /** What is unproven about it here. Never blank. */
  readonly unverified: string;
}

/**
 * The graphic-poster shape.
 *
 * Extracted from a ByteDance Seedream 5.0 Pro prompt in a reference ComfyUI workflow. The
 * prompt is one paragraph of prose, and reading it back it turns out to be seven slots in a
 * fixed order, every one of them filled — which is why it produces a composed poster rather
 * than a subject on a background:
 *
 *   subject          "a striking portrait of a female android with glossy chrome skin"
 *   surface          "liquid chrome"; and separately what must NOT happen to it —
 *                    "no cracks or broken facial surfaces"
 *   colour event     "a vivid swirling streak of neon orange, yellow and pink liquid paint
 *                    brush stroke horizontally covers her eyes"
 *   background       "dark, textured charcoal gray"
 *   typography       "large bold white futuristic typography reads '…' with a subtle
 *                    digital glitch and halftone texture"
 *   decoration       "technical HUD elements, thin white lines, geometric wireframe
 *                    diagrams, barcodes, small sci-fi text boxes"
 *   mood             "high-tech, dystopian, avant-garde"
 *
 * The surface slot is the interesting one: it carries a negative clause inside a positive
 * prompt. Models that have no negative-prompt parameter get their exclusions this way, and
 * an author who does not know that leaves them out and gets cracked chrome.
 */
export const GRAPHIC_POSTER: Skeleton = {
  key: 'graphic-poster',
  label: 'Graphic poster — designed surface, typography, decoration',
  shotKinds: ['graphic_plate', 'detail_macro'],
  slots: [
    { name: 'subject', asks: 'What is centred. One noun phrase with its material.' },
    {
      name: 'surface',
      asks:
        'How the material behaves, and what must not happen to it. The negative clause ' +
        'belongs here when the model has no negative-prompt parameter.',
    },
    {
      name: 'colour_event',
      asks: 'The one thing that breaks the surface — a stroke, a spill, a light. Where it sits.',
    },
    { name: 'background', asks: 'Tone and texture. Not a scene; a field.' },
    {
      name: 'typography',
      asks: 'The exact words in quotes, the weight, and the treatment. Omit if none.',
    },
    { name: 'decoration', asks: 'The furniture around the subject — lines, diagrams, marks.' },
    { name: 'mood', asks: 'Two or three adjectives, last, as a summary rather than a request.' },
  ],
  provenance:
    'ByteDance Seedream 5.0 Pro text-to-image prompt, reference ComfyUI workflow, read as a ' +
    'slot structure rather than copied.',
  unverified:
    'Never run against our video driver. Different model, different vendor, no params blob, ' +
    'no sample output. This is a shape to author against, not a recipe to save.',
};

export const SKELETONS: readonly Skeleton[] = [GRAPHIC_POSTER];

/** The skeleton text an author starts from. Placeholders are the author's, not a template's. */
export function skeletonOutline(s: Skeleton): string {
  return s.slots.map((slot) => `${slot.name}: `).join('\n');
}
