import { Composition } from 'remotion';

import { KilnVideo, type KilnVideoProps } from './kiln-video';

/**
 * Remotion's entry point. Bundled by `src/lib/assemble/render.ts`, never imported by the app.
 *
 * The dimensions and frame count registered here are placeholders — every one of them is
 * overridden per render from the `CompositionPlan`, because a 9:16 short and a 16:9 longform
 * are the same composition at different sizes and `planComposition` is what knows which.
 * Remotion requires *some* value at registration time; these are the shorts defaults so that
 * a mistaken render is a plausible short rather than a 1×1 frame nobody notices.
 */

const DEFAULT_PROPS: KilnVideoProps = {
  plan: {
    format: 'shorts_9x16',
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 30,
    safeArea: { top: 0.08, bottom: 0.2, left: 0.05, right: 0.14, verified: false, note: '' },
    safeBox: { x: 54, y: 154, width: 875, height: 1382 },
    cues: [],
    hook: null,
    problems: [],
  },
  clipUrls: [],
  clipFrames: [],
};

export function RemotionRoot() {
  return (
    <Composition
      id="kiln-video"
      component={KilnVideo}
      durationInFrames={30}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={DEFAULT_PROPS}
    />
  );
}
