/**
 * Colour for things that are not the interface.
 *
 * Three surfaces in this app paint pixels rather than style DOM, and none of them can read
 * a CSS custom property:
 *
 *   The review composition burns captions into video frames. Remotion renders it in a
 *   headless browser during a real render, where the app's stylesheet is not loaded at all,
 *   so `var(--surface-1)` resolves to nothing and the caption comes out transparent.
 *
 *   wavesurfer paints a `<canvas>`. `waveColor` is passed to a 2D context, which takes a
 *   colour string and has never heard of custom properties.
 *
 *   The tour scene paints a WebGL `<canvas>`. Materials take a hex integer, which is one
 *   further step removed again — not merely a string outside CSS, but a number.
 *
 * So these have to be literals. They live here rather than inline in the two components for
 * exactly the reason `no-primitive-tokens` exists: the point of the token layer is that
 * changing a colour is one edit and not forty, and that argument does not stop being true
 * because the paint happens on a canvas.
 *
 * This file is in `src/styles/` deliberately — it *is* the token layer for media, and the
 * lint rule's own exemption is that directory. Nothing here is a UI colour and nothing in
 * the UI should import it.
 *
 * The values track the dark palette in `tokens.css`. They are duplicated rather than
 * derived because the burned-in ones must not change with a viewer's theme: a caption
 * rendered white-on-black into an MP4 is white-on-black forever, and a light-theme render
 * of the same composition would be a different video.
 */

/** Burned into video frames. Fixed for the same reason a subtitle file has no theme. */
export const VIDEO_PAINT = {
  /** Letterbox and the space behind every clip. */
  background: '#000000',
  /** A shot with no asset. Legible, and visibly not a dropped frame. */
  placeholderSurface: '#161a1c',
  placeholderText: '#8a9296',
  placeholderSubtext: '#5f676b',
  captionBackground: 'rgba(0,0,0,0.62)',
  captionText: '#ffffff',
} as const;

/** Painted into the waveform canvas. Tracks the dark UI, because it sits inside it. */
export const WAVEFORM_PAINT = {
  wave: '#3c4448',
  progress: '#6b7a80',
  cursor: '#e6e8e9',
  /** Alternating caption regions, drawn over the canvas as DOM. */
  regionEven: 'rgba(107,122,128,0.10)',
  regionOdd: 'rgba(107,122,128,0.04)',
} as const;

/**
 * The tour scene, as hex integers.
 *
 * Numbers rather than strings because a three.js material takes `0x161a1c` — parsing a CSS
 * string is work the library does at construction and then never again, so the literal form
 * that matches the consumer is the honest one.
 *
 * The scene is a *background*. Everything here is deliberately close to `--surface-*` and
 * `--text-*`, and nothing is saturated: the words sit on top of it and must stay the thing
 * being read. `held` is the one exception and the one place the eye is meant to go — it is
 * the amber of a refusal, which is the single most important behaviour the tour claims.
 */
export const SCENE_PAINT = {
  /** A stage that has not been reached yet. Barely above the page. */
  stageIdle: 0x272d30,
  /** A stage the pulse has passed. */
  stageDone: 0x4a5458,
  /** The stage this beat is about. */
  stageActive: 0x9aa5a9,
  /** Held, not failed — a refusal is a decision. */
  stageHeld: 0xe0a458,
  /** The publish gate, closed. */
  gate: 0x3c4448,
  /** Cost rows accumulating under the track. */
  ledger: 0x4db6ac,
  /** The travelling marker. */
  pulse: 0xe6e8e9,
} as const;
