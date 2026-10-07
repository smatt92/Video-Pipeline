import type { CameraMove } from './overlay-scene';

/**
 * The slow camera move on a scene still (decision 0021). Pure and deterministic:
 * (camera, seed, progress 0→1) → a transform, so every render of a cut moves identically.
 *
 * Every move keeps the image covering the frame: scale never drops below `MIN_SCALE`, and a
 * pan travels at most half of the overscan that scale buys, so no edge of the picture ever
 * shows. Easing is a smoothstep — a still that starts and stops moving abruptly reads as a
 * glitch, not a camera.
 */

export interface KenBurns {
  /** Fraction of the frame, applied as a CSS translate percentage. */
  x: number;
  y: number;
  scale: number;
  rotateDeg: number;
}

export const MIN_SCALE = 1.08;

const ease = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

export function kenBurns(camera: CameraMove, seed: number, progress: number): KenBurns {
  const t = ease(progress);
  // Direction from the seed, so neighbouring shots do not all drift the same way.
  const dir = Math.abs(Math.floor(seed)) % 2 === 0 ? 1 : -1;
  switch (camera) {
    case 'slow pan': {
      const scale = 1.12;
      const travel = (scale - 1) / 2 - 0.01; // stay inside the overscan
      return { x: dir * travel * (t * 2 - 1), y: 0, scale, rotateDeg: 0 };
    }
    case 'slow dolly-in':
      return { x: 0, y: 0, scale: MIN_SCALE + 0.1 * t, rotateDeg: 0 };
    case 'slow orbit': {
      const scale = 1.14;
      return { x: dir * 0.02 * Math.sin(t * Math.PI), y: 0.015 * (t - 0.5), scale, rotateDeg: dir * 1.2 * (t - 0.5) };
    }
    case 'static':
    default:
      return { x: 0, y: 0, scale: MIN_SCALE + 0.03 * t, rotateDeg: 0 };
  }
}
