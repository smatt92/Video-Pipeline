'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

/**
 * Decides whether the tour gets a 3D backdrop, and loads the code only if so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything here is about *not* loading three.js
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The tour is the first screen a stranger sees, before sign-in, on whatever connection they
 * happen to be on. three.js is a few hundred kilobytes of JavaScript for a decorative
 * backdrop — so the question is not "can we lazy-load it" but "who should never receive it
 * at all", and there are three answers:
 *
 *   Anyone who has asked for reduced motion. Not a downgrade: the scene is motion and
 *   nothing else, so honouring the preference means there is nothing left to show. Sending
 *   the chunk and then not animating would be the worst of both.
 *
 *   Anyone whose browser cannot make a WebGL context. Probed with a throwaway canvas
 *   before the import, so a device that would have failed never pays for the download.
 *
 *   Anyone on a connection or a data plan that says not to. `navigator.connection` is
 *   advisory and absent on Safari and Firefox, which is fine — absent means "no reason not
 *   to", and the two that do report it are the two where it matters most.
 *
 * `ssr: false` is doing real work rather than being ceremony: three.js touches `window` at
 * module scope, and a server render would crash the one route that must survive anything.
 *
 * ── Why the probe is not just `!!window.WebGLRenderingContext` ───────────────
 *
 * That constructor exists on machines where context creation fails — software rendering
 * disabled, a GPU blocklist entry, too many live contexts. The only honest test is to make
 * one, so this makes one, reads the answer, and immediately gives it back.
 */

const TourScene = dynamic(() => import('./tour-scene'), {
  ssr: false,
  // No skeleton. A placeholder for a backdrop is a flash of something that is not the
  // backdrop, and the screen is complete without it by design.
  loading: () => null,
});

type Verdict = 'deciding' | 'yes' | 'no';

function canRenderWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return false;
    // Hand it straight back. A probe that keeps its context is a probe that can cause the
    // failure it was testing for.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Advisory, and absent in most browsers. Absent means yes. */
function connectionSaysNo(): boolean {
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const c = nav.connection;
  if (!c) return false;
  if (c.saveData) return true;
  return c.effectiveType === 'slow-2g' || c.effectiveType === '2g';
}

export function TourBackdrop({ index }: { index: number }) {
  const [verdict, setVerdict] = useState<Verdict>('deciding');

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const decide = () => {
      if (motion.matches || connectionSaysNo() || !canRenderWebGL()) {
        setVerdict('no');
        return;
      }
      setVerdict('yes');
    };

    // Live, not read-once. Someone who turns reduced motion on part-way through the tour is
    // usually doing it *because* of what is on the screen, and a preference honoured on the
    // next page load is a preference that did not work.
    motion.addEventListener('change', decide);
    decide();
    return () => motion.removeEventListener('change', decide);
  }, []);

  if (verdict !== 'yes') return null;

  // A lost context is permanent for this mount. Not retried: the causes — a driver reset, a
  // battery-triggered GPU switch, a browser reclaiming contexts — are all states that
  // persist, and a backdrop that keeps trying to come back is a backdrop that flickers
  // behind text somebody is reading.
  return <TourScene index={index} onContextLost={() => setVerdict('no')} />;
}
