/**
 * Colour for things that are not the interface.
 *
 * Two surfaces in this app paint pixels rather than style DOM, and neither can read a CSS
 * custom property:
 *
 *   The review composition burns captions into video frames. Remotion renders it in a
 *   headless browser during a real render, where the app's stylesheet is not loaded at all,
 *   so `var(--surface-1)` resolves to nothing and the caption comes out transparent.
 *
 *   wavesurfer paints a `<canvas>`. `waveColor` is passed to a 2D context, which takes a
 *   colour string and has never heard of custom properties.
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
