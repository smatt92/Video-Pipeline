'use client';

import { useEffect, useRef } from 'react';
import * as THREE from 'three';

import { SCENE_PAINT } from '@/styles/media-paint';
import { STAGES, beatFor, stageHeight, stageX, type Beat } from '@/lib/onboarding/scene';
import { TOUR } from '@/lib/onboarding/tour';

/**
 * The tour's 3D layer. Loaded only when it can run, and only when it should.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * It is a backdrop, not a renderer
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The obvious build is two renderers — a 3D tour and a flat one — reading the same content
 * array. That is what an earlier note in `tour.ts` imagined, and it is worse than this, for
 * a reason worth writing down: two renderers means two implementations of the controls, the
 * keyboard handling, the progress marks and the cookie write, and the one that runs less
 * often is the one that rots. It also means the copy is laid out twice, which is how a
 * fallback becomes a summary.
 *
 * So this draws behind `TourScreen` and nothing else. The words, the buttons, the focus
 * order and the seen-cookie all have exactly one implementation, which is the one everybody
 * gets. This adds where the stages sit relative to each other and takes nothing away when
 * it is absent — because when it is absent, the tour is unchanged rather than degraded.
 *
 * `aria-hidden` and `role="presentation"` follow from that: it carries no information a
 * screen reader would otherwise miss, because by construction it carries no information at
 * all beyond arrangement.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The loop, and the three things that stop it
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **Reduced motion.** Checked in JS with `matchMedia`, not in CSS. The splash mark can
 *    animate in CSS and be stopped by a media query without knowing the preference exists —
 *    a `requestAnimationFrame` loop has nothing to ask with, so it has to ask. The gate is
 *    in the parent, which does not import this file until the answer is no. The listener is
 *    live: someone who turns the preference on mid-tour gets it honoured on the spot, which
 *    matters because that is exactly when a person turns it on.
 *
 * 2. **A hidden tab.** `visibilitychange` cancels the frame. A background tab spinning a
 *    GPU is a laptop fan for a page nobody is looking at, and browsers throttle rAF but do
 *    not always stop it.
 *
 * 3. **A lost context.** `webglcontextlost` is not exotic — a GPU driver reset, a laptop
 *    switching cards on battery, or a browser reclaiming contexts from too many canvases.
 *    Default behaviour is a frozen last frame, which reads as the page having hung. The
 *    event is preventDefault'd and reported upward, the parent unmounts this, and the tour
 *    carries on: DOM, so there is nothing to restore.
 *
 * ── Cost ────────────────────────────────────────────────────────────────────
 *
 * `MeshBasicMaterial` throughout, so no lights and no shadow maps: the scene is flat
 * colour, which is what a backdrop behind text should be anyway. Device pixel ratio is
 * capped — at 4K with DPR 2 an uncapped canvas is 33 million pixels a frame to draw
 * eleven boxes, and the visible difference on a backdrop is nil.
 */

/** Cheap on a phone, indistinguishable on a desktop, and bounded on a 4K panel. */
const MAX_DPR = 1.75;

/**
 * How solid the scene is allowed to be.
 *
 * Translucent, but not by much. The first attempt at fixing the legibility bug turned these
 * down to 0.34 *as well as* moving the camera, and the result was a backdrop that measured
 * perfectly and could not be seen — the geometry composited to within about nine values of
 * the page background.
 *
 * The camera work in `scene.ts` is what keeps the scene out of the text column, and that is
 * the mechanism that has to hold. Alpha here is for depth, so the track reads as sitting
 * behind the page rather than on it. `HELD_ALPHA` is higher still because the amber stage
 * is the one thing on the screen the eye is meant to find.
 */
const STAGE_ALPHA = 0.8;
const HELD_ALPHA = 0.95;

/** How fast the camera and the colours chase their targets, per second. */
const EASE = 3.4;

export interface TourSceneProps {
  /** Which tour step is on screen. Drives the beat. */
  index: number;
  /** Called when the GPU context is lost. The parent is expected to unmount this. */
  onContextLost: () => void;
}

export default function TourScene({ index, onContextLost }: TourSceneProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  // The beat is read through a ref rather than being a dependency of the effect: the
  // effect builds a GPU context, and rebuilding one on every step would be both slow and
  // the source of the context exhaustion this file is defending against.
  const indexRef = useRef(index);
  indexRef.current = index;

  const lostRef = useRef(onContextLost);
  lostRef.current = onContextLost;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 1.6, 6.2);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        // A backdrop is not worth a discrete GPU. On a laptop this is the difference
        // between the tour costing battery and not.
        powerPreference: 'low-power',
      });
    } catch {
      // Context creation can fail even after the parent's probe succeeded — the probe
      // makes a context and the browser may refuse the next one. Same outcome as a loss.
      lostRef.current();
      return;
    }

    renderer.setClearAlpha(0);
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    // ── The track ────────────────────────────────────────────────────────────
    const disposables: { dispose(): void }[] = [];
    const track = new THREE.Group();
    scene.add(track);

    const stageMeshes = STAGES.map(({ n }) => {
      const h = stageHeight(n);
      const geometry = new THREE.BoxGeometry(0.18, h, 0.18);
      const material = new THREE.MeshBasicMaterial({
        color: SCENE_PAINT.stageIdle,
        transparent: true,
        opacity: STAGE_ALPHA,
      });
      disposables.push(geometry, material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(stageX(n), h / 2, 0);
      track.add(mesh);
      return { n, mesh, material };
    });

    // ── The ledger, underneath ───────────────────────────────────────────────
    //
    // Under the track and not beside it, because that is the claim: the cost accumulates
    // beneath the work rather than being reported next to it.
    const ledgerMeshes = STAGES.map(({ n }) => {
      const geometry = new THREE.BoxGeometry(0.34, 0.05, 0.14);
      const material = new THREE.MeshBasicMaterial({
        color: SCENE_PAINT.ledger,
        transparent: true,
        opacity: 0,
      });
      disposables.push(geometry, material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(stageX(n), -0.22, 0);
      track.add(mesh);
      return { n, mesh, material };
    });

    // ── The publish gate, between stage 8 and stage 9 ────────────────────────
    const gateGeometry = new THREE.PlaneGeometry(0.06, 1.5);
    const gateMaterial = new THREE.MeshBasicMaterial({
      color: SCENE_PAINT.gate,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
    });
    disposables.push(gateGeometry, gateMaterial);
    const gate = new THREE.Mesh(gateGeometry, gateMaterial);
    gate.position.set((stageX(8) + stageX(9)) / 2, 0.75, 0);
    track.add(gate);

    // ── The marker that travels the track ────────────────────────────────────
    const pulseGeometry = new THREE.SphereGeometry(0.055, 12, 8);
    const pulseMaterial = new THREE.MeshBasicMaterial({
      color: SCENE_PAINT.pulse,
      transparent: true,
      opacity: 0.85,
    });
    disposables.push(pulseGeometry, pulseMaterial);
    const pulse = new THREE.Mesh(pulseGeometry, pulseMaterial);
    pulse.position.set(stageX(1), 0.06, 0.26);
    track.add(pulse);

    // ── The one flow line: stage 6 back to stage 5 ───────────────────────────
    const flowGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, 0),
    ]);
    const flowMaterial = new THREE.LineBasicMaterial({
      color: SCENE_PAINT.stageActive,
      transparent: true,
      opacity: 0,
    });
    disposables.push(flowGeometry, flowMaterial);
    const flow = new THREE.Line(flowGeometry, flowMaterial);
    track.add(flow);

    /**
     * A narrow viewport is where the two constraints fight.
     *
     * Widening the field of view fits the track in horizontally, and the same change makes
     * everything smaller *and closer to frame centre* vertically — which is where the text
     * is, on a screen that has no room to spare. Measured, this took the worst composited
     * contrast under the paragraph from 9.58:1 to 4.58:1: still a pass, and a pass with no
     * margin at all, which on a phone is one copy edit away from being a fail.
     *
     * So the camera also lifts, which pushes the track further down the frame. Applied to
     * `camera.y` and `lookAt.y` equally, because the level-camera rule in `scene.ts` is
     * what makes the arithmetic predictable and tilting here would quietly break it.
     */
    let narrow = false;
    const NARROW_LIFT = 0.6;

    // ── Sizing ───────────────────────────────────────────────────────────────
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (w === 0 || h === 0) return;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;

      // On a narrow viewport the eleven-stage track is wider than the frustum, so the
      // whole point of drawing eleven of them is lost. Pulling the camera back is the
      // wrong fix — it shrinks the stages to dust. Widening the field of view keeps them
      // the same size on screen and fits more of the track in.
      narrow = w < 640;
      camera.fov = narrow ? 52 : 38;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    // ── The loop ─────────────────────────────────────────────────────────────
    const target = new THREE.Vector3();
    const look = new THREE.Vector3();
    const currentLook = new THREE.Vector3(0, 0.2, 0);
    const color = new THREE.Color();

    let frame = 0;
    let last = performance.now();
    let travelled = 0;
    let beatId = '';

    const moodColor = (beat: Beat, n: number): number => {
      const mood = beat.lit[n];
      if (mood === 'held') return SCENE_PAINT.stageHeld;
      if (mood === 'active') return SCENE_PAINT.stageActive;
      if (mood === 'done') return SCENE_PAINT.stageDone;
      // Not named by the beat: idle unless the marker has already gone past it.
      return travelled >= n ? SCENE_PAINT.stageDone : SCENE_PAINT.stageIdle;
    };

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      // Clamped, because a tab that was hidden for a minute reports a minute here and
      // every eased value would snap rather than move.
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const step = TOUR[Math.min(indexRef.current, TOUR.length - 1)]!;
      const beat = beatFor(step);
      if (step.id !== beatId) {
        beatId = step.id;
        travelled = 0;
      }

      const k = 1 - Math.exp(-EASE * dt);

      const lift = narrow ? NARROW_LIFT : 0;
      target.set(beat.camera[0], beat.camera[1] + lift, beat.camera[2]);
      camera.position.lerp(target, k);
      look.set(beat.lookAt[0], beat.lookAt[1] + lift, beat.lookAt[2]);
      currentLook.lerp(look, k);
      camera.lookAt(currentLook);

      // The marker walks the track and stops where the beat says. `pulseStopsAt` null runs
      // it to the end and holds there rather than looping — a looping marker is a spinner,
      // and a spinner behind a paragraph is the most distracting thing a backdrop can do.
      const stop = beat.pulseStopsAt ?? STAGES.length;
      travelled = Math.min(stop, travelled + dt * 2.6);
      pulse.position.x = stageX(Math.max(1, travelled));
      pulse.visible = travelled > 0.2;

      for (const { n, material } of stageMeshes) {
        const hex = moodColor(beat, n);
        color.setHex(hex);
        material.color.lerp(color, k);
        const wanted = hex === SCENE_PAINT.stageHeld ? HELD_ALPHA : STAGE_ALPHA;
        material.opacity += (wanted - material.opacity) * k;
      }

      for (const { n, material } of ledgerMeshes) {
        // The ledger fills left to right in proportion to the beat's figure, so the last
        // step's pull-back reveals a full row rather than an animation starting.
        const filledTo = beat.ledger * STAGES.length;
        material.opacity += ((n <= filledTo ? 0.85 : 0) - material.opacity) * k;
      }

      gateMaterial.opacity += ((beat.gateClosed ? 0.75 : 0) - gateMaterial.opacity) * k;

      if (beat.flow) {
        const [from, to] = beat.flow;
        const positions = flowGeometry.getAttribute('position') as THREE.BufferAttribute;
        positions.setXYZ(0, stageX(from), stageHeight(from) + 0.16, 0);
        positions.setXYZ(1, stageX(to), stageHeight(to) + 0.16, 0);
        positions.needsUpdate = true;
        flowMaterial.opacity += (0.8 - flowMaterial.opacity) * k;
      } else {
        flowMaterial.opacity += (0 - flowMaterial.opacity) * k;
      }

      renderer.render(scene, camera);
    };

    // ── The three things that stop it ────────────────────────────────────────
    const start = () => {
      if (frame !== 0) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame === 0) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };

    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVisibility);

    const canvas = renderer.domElement;
    const onLost = (e: Event) => {
      // Without preventDefault the browser will not fire `webglcontextrestored` — which we
      // do not use, but the default here is also "keep showing the last frame", and a
      // frozen render behind a live page is worse than no render at all.
      e.preventDefault();
      stop();
      lostRef.current();
    };
    canvas.addEventListener('webglcontextlost', onLost);

    start();

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onLost);
      observer.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      // Hands the context back rather than waiting for the GC. Browsers cap live WebGL
      // contexts at a low number and drop the oldest silently when the cap is hit, so a
      // tour replayed a few times could otherwise take out a context somebody else's
      // component was using.
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      role="presentation"
      className="pointer-events-none fixed inset-0 -z-10"
      // Fades in rather than appearing. The chunk arrives after the words are already on
      // screen, and a backdrop that pops in reads as the page having reloaded.
      style={{ animation: 'kiln-scene-in var(--duration-slow, 600ms) ease-out both' }}
    />
  );
}
