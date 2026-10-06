import { MathUtils, PerspectiveCamera, Vector3 } from 'three';

/**
 * The Bureau's overlays: chalk-line diagrams on navy blueprint paper, built as a Three.js
 * scene (points in 3D, a perspective camera that pans, dollies or orbits) and projected to
 * 2D polylines that the composition draws as SVG.
 *
 * ── Why projection to SVG and not a WebGL canvas ─────────────────────────────
 *
 * CLAUDE.md records the trap exactly: headless Chromium does not reliably composite a WebGL
 * layer into the frames a renderer captures, and a scene that is drawn can be captured as
 * empty. The chalk-line look is lines and dots anyway, so the scene is projected with
 * Three's own camera math and drawn as SVG — no GPU, no compositor layer, identical on a
 * laptop, a CI runner and the Trigger worker, and testable in Node without a browser.
 *
 * Pure and deterministic: (spec, progress, size) → the same paths every time. `progress`
 * runs 0→1 across the shot; lines "draw on" over the first 60% and hold.
 */

export const OVERLAY_KINDS = ['orbit', 'cross_section', 'exploded_view', 'particles', 'graph', 'timeline', 'map', 'diagram'] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];
export const CAMERA_MOVES = ['static', 'slow pan', 'slow dolly-in', 'slow orbit'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export interface OverlaySpec {
  kind: OverlayKind;
  camera: CameraMove;
  /** The lead character's accent; one element per diagram carries it. */
  accent: string;
  seed: number;
}

export interface Path2D {
  points: [number, number][];
  color: string;
  width: number;
  closed?: boolean;
}
export interface Dot2D {
  x: number;
  y: number;
  r: number;
  color: string;
}
export interface Projected {
  paths: Path2D[];
  dots: Dot2D[];
}

export const PAPER = { paper: '#0B1F3A', grid: '#1C3A63', chalk: '#F4F1E8' } as const;

type Line3 = { pts: Vector3[]; accent?: boolean; closed?: boolean; width?: number };

function rng(seed: number) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const circle = (r: number, n = 64, y = 0, cx = 0, cz = 0) =>
  Array.from({ length: n + 1 }, (_, i) => new Vector3(cx + r * Math.cos((i / n) * Math.PI * 2), y, cz + r * Math.sin((i / n) * Math.PI * 2)));
const vcircle = (r: number, n = 64, cx = 0, cy = 0, z = 0) =>
  Array.from({ length: n + 1 }, (_, i) => new Vector3(cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2), z));

/** The scene, as 3D polylines, at a given progress (some kinds move). */
export function buildScene(spec: OverlaySpec, p: number): { lines: Line3[]; dots: { at: Vector3; r: number; accent?: boolean }[] } {
  const R = rng(spec.seed);
  const lines: Line3[] = [];
  const dots: { at: Vector3; r: number; accent?: boolean }[] = [];
  switch (spec.kind) {
    case 'orbit': {
      lines.push({ pts: vcircle(0.9, 48) });
      lines.push({ pts: Array.from({ length: 97 }, (_, i) => new Vector3(2.6 * Math.cos((i / 96) * Math.PI * 2), 0.35 * Math.sin((i / 96) * Math.PI * 2), 1.6 * Math.sin((i / 96) * Math.PI * 2))), accent: true });
      const a = p * Math.PI * 2 * 0.5 + R() * Math.PI;
      dots.push({ at: new Vector3(2.6 * Math.cos(a), 0.35 * Math.sin(a), 1.6 * Math.sin(a)), r: 0.18, accent: true });
      lines.push({ pts: [new Vector3(0, 0, 0), new Vector3(2.6 * Math.cos(a) * 0.6, 0, 1.6 * Math.sin(a) * 0.6)] });
      break;
    }
    case 'cross_section': {
      for (const [i, r] of [2.4, 1.8, 1.2, 0.6].entries()) {
        lines.push({ pts: Array.from({ length: 33 }, (_, k) => new Vector3(r * Math.cos(Math.PI * (k / 32)), r * Math.sin(Math.PI * (k / 32)), 0)), accent: i === 2 });
      }
      lines.push({ pts: [new Vector3(-2.6, 0, 0), new Vector3(2.6, 0, 0)] });
      break;
    }
    case 'exploded_view': {
      const spread = 0.2 + 1.4 * MathUtils.smoothstep(p, 0.15, 0.85);
      const face = (axis: Vector3, accent: boolean) => {
        const u = Math.abs(axis.x) > 0 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
        const v = new Vector3().crossVectors(axis, u);
        const c = axis.clone().multiplyScalar(0.8 + spread);
        const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1], [1, 1]].map(([a, b]) => c.clone().add(u.clone().multiplyScalar(0.8 * a)).add(v.clone().multiplyScalar(0.8 * b)));
        lines.push({ pts: corners, accent, closed: true });
      };
      [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)].forEach((a, i) => face(a, i === 2));
      break;
    }
    case 'particles': {
      const n = 36;
      const pts = Array.from({ length: n }, () => new Vector3((R() - 0.5) * 5, (R() - 0.5) * 6, (R() - 0.5) * 2));
      const drift = pts.map((v, i) => v.clone().add(new Vector3(Math.sin(p * 3 + i) * 0.3, p * 0.8 * (R() - 0.5), 0)));
      drift.forEach((v, i) => dots.push({ at: v, r: 0.05 + (i % 7 === 0 ? 0.05 : 0), accent: i % 7 === 0 }));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (drift[i].distanceTo(drift[j]) < 1.1) lines.push({ pts: [drift[i], drift[j]], width: 1 });
      break;
    }
    case 'graph': {
      lines.push({ pts: [new Vector3(-2.4, -2.4, 0), new Vector3(-2.4, 2.6, 0)] });
      lines.push({ pts: [new Vector3(-2.4, -2.4, 0), new Vector3(2.6, -2.4, 0)] });
      const k = 0.6 + R() * 1.2;
      lines.push({ pts: Array.from({ length: 61 }, (_, i) => new Vector3(-2.4 + (5 * i) / 60, -2.4 + 4.6 * (1 - Math.exp(-k * ((5 * i) / 60))), 0)), accent: true });
      break;
    }
    case 'timeline': {
      lines.push({ pts: [new Vector3(-2.8, 0, 0), new Vector3(2.8, 0, 0)] });
      const marks = 5 + Math.floor(R() * 3);
      for (let i = 0; i < marks; i++) {
        const x = -2.6 + (5.2 * i) / (marks - 1);
        lines.push({ pts: [new Vector3(x, -0.25, 0), new Vector3(x, 0.25, 0)], accent: i === marks - 2 });
        dots.push({ at: new Vector3(x, 0.6 + 0.4 * Math.sin(i * 1.7), 0), r: 0.09, accent: i === marks - 2 });
      }
      break;
    }
    case 'map': {
      for (let c = 0; c < 3; c++) {
        const cx = (R() - 0.5) * 3.5;
        const cy = (R() - 0.5) * 4;
        const base = 0.6 + R() * 0.8;
        const ph = R() * 10;
        lines.push({ pts: Array.from({ length: 49 }, (_, i) => { const a = (i / 48) * Math.PI * 2; const r = base * (1 + 0.25 * Math.sin(3 * a + ph) + 0.12 * Math.sin(7 * a + ph)); return new Vector3(cx + r * Math.cos(a), cy + r * Math.sin(a), 0); }), closed: true });
      }
      lines.push({ pts: Array.from({ length: 21 }, (_, i) => new Vector3(-2 + (4 * i) / 20, -1.5 + 3 * (i / 20) + 0.5 * Math.sin(i / 3), 0.01)), accent: true });
      break;
    }
    case 'diagram':
    default: {
      const boxes = [new Vector3(-1.6, 1.6, 0), new Vector3(1.6, 1.6, 0), new Vector3(0, -1.4, 0)];
      boxes.forEach((b, i) => lines.push({ pts: [[-0.9, -0.55], [0.9, -0.55], [0.9, 0.55], [-0.9, 0.55], [-0.9, -0.55]].map(([x, y]) => new Vector3(b.x + x, b.y + y, 0)), accent: i === 2, closed: true }));
      const arrow = (a: Vector3, b: Vector3) => {
        lines.push({ pts: [a, b] });
        const d = b.clone().sub(a).normalize().multiplyScalar(0.25);
        const n = new Vector3(-d.y, d.x, 0);
        lines.push({ pts: [b.clone().sub(d).add(n), b, b.clone().sub(d).sub(n)] });
      };
      arrow(new Vector3(-0.7, 1.6, 0), new Vector3(0.7, 1.6, 0));
      arrow(new Vector3(1.4, 1.0, 0), new Vector3(0.4, -0.8, 0));
      arrow(new Vector3(-0.4, -0.8, 0), new Vector3(-1.4, 1.0, 0));
      break;
    }
  }
  return { lines, dots };
}

function cameraFor(spec: OverlaySpec, p: number, aspect: number): PerspectiveCamera {
  const cam = new PerspectiveCamera(45, aspect, 0.1, 100);
  const dist = spec.camera === 'slow dolly-in' ? 13 - 3 * p : 12;
  const yaw = spec.camera === 'slow orbit' ? (p - 0.5) * 0.9 : spec.kind === 'orbit' || spec.kind === 'exploded_view' ? 0.5 : 0;
  const pitch = spec.kind === 'orbit' || spec.kind === 'exploded_view' ? 0.35 : 0;
  const pan = spec.camera === 'slow pan' ? (p - 0.5) * 1.2 : 0;
  cam.position.set(pan + dist * Math.sin(yaw) * Math.cos(pitch), dist * Math.sin(pitch), dist * Math.cos(yaw) * Math.cos(pitch));
  cam.lookAt(new Vector3(pan, 0, 0));
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}

/** Draw-on: a line shows its first `share` of points; everything is fully drawn by p = 0.6. */
const drawShare = (p: number, i: number, n: number) => MathUtils.clamp((p - (0.3 * i) / Math.max(1, n)) / 0.3, 0, 1);

export function projectOverlay(spec: OverlaySpec, progress: number, width: number, height: number): Projected {
  const p = MathUtils.clamp(progress, 0, 1);
  const { lines, dots } = buildScene(spec, p);
  const cam = cameraFor(spec, p, width / height);
  const scale = Math.min(width, height);
  const toScreen = (v: Vector3): [number, number] => {
    const q = v.clone().project(cam);
    return [Math.round(((q.x + 1) / 2) * width * 10) / 10, Math.round(((1 - q.y) / 2) * height * 10) / 10];
  };
  const paths: Path2D[] = lines.map((l, i) => {
    const keep = Math.max(2, Math.ceil(l.pts.length * drawShare(p, i, lines.length)));
    return {
      points: l.pts.slice(0, Math.min(l.pts.length, keep)).map(toScreen),
      color: l.accent ? spec.accent : PAPER.chalk,
      width: Math.max(1.5, (l.width ?? (l.accent ? 5 : 3.5)) * (scale / 1080)),
      closed: l.closed && drawShare(p, i, lines.length) >= 1,
    };
  });
  const dotShare = MathUtils.clamp((p - 0.2) / 0.3, 0, 1);
  const projectedDots: Dot2D[] = dots.slice(0, Math.ceil(dots.length * dotShare)).map((d) => {
    const [x, y] = toScreen(d.at);
    return { x, y, r: Math.max(2, d.r * scale * 0.06), color: d.accent ? spec.accent : PAPER.chalk };
  });
  return { paths, dots: projectedDots };
}

/** A shot's overlay spec from whatever the brief or series template carried. */
export function normaliseOverlay(raw: unknown, accent: string, seed: number): OverlaySpec {
  const o = (raw ?? {}) as { kind?: unknown; camera?: unknown };
  const kind = OVERLAY_KINDS.includes(o.kind as OverlayKind) ? (o.kind as OverlayKind) : 'diagram';
  const camera = CAMERA_MOVES.includes(o.camera as CameraMove) ? (o.camera as CameraMove) : 'slow dolly-in';
  return { kind, camera, accent, seed };
}
