#!/usr/bin/env node
/**
 * The tour backdrop, in a real browser, against the real built page.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this exists when `test:tour` already passes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `test:tour` reads the source and asserts that the words `visibilitychange` and
 * `webglcontextlost` appear in it. That is a format check wearing a test's clothes: it
 * proves somebody typed the right string, not that a canvas ever appeared on a screen. It
 * is worth keeping — it fails fast, it needs no browser, and it catches a refactor that
 * drops a listener — but it must not be mistaken for evidence that the scene renders.
 *
 * This is the evidence. It starts the actual production server, points a real Chromium at
 * the actual `/onboarding` route, and asks the page what happened:
 *
 *   PROVES:  a WebGL canvas mounts and is sized; the renderer painted more than one colour,
 *            so the scene drew rather than merely initialising; the words are on screen
 *            with and without it; `prefers-reduced-motion` suppresses the canvas entirely
 *            *and leaves the tour intact*; and a forced context loss removes the canvas
 *            while the tour keeps working.
 *
 *   DOES NOT: say the scene looks right. Nothing automated can. What it rules out is the
 *             failure mode that matters — that the backdrop is the reason somebody cannot
 *             read the tour.
 *
 * The context-loss case is the one worth having a machine do. It is unreachable by hand
 * without a driver crash, it is the single path where a bug would show a frozen frame over
 * a live page, and `WEBGL_lose_context` makes it a one-line trigger.
 *
 * Headless Chromium has no GPU, so WebGL runs on SwiftShader — which is exactly the
 * software path a blocklisted GPU would take, and therefore a fair test of the fallback
 * rather than a compromise.
 *
 * ── Do not trust a headless screenshot of this page ──────────────────────────
 *
 * `Page.captureScreenshot` here returns the page with the WebGL layer *missing* — not dark,
 * not faint: absent — while `readPixels` on the same canvas at the same moment reports the
 * scene drawn and on screen. That cost an hour of retuning a scene that was already correct,
 * on the evidence of a screenshot that could not show it.
 *
 * So every measurement in this file comes from inside the page. If you want to look at the
 * backdrop, open it in a browser with a GPU; a picture taken here is evidence of nothing.
 *
 * Usage: node scripts/verify-tour.mjs [port]
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findChrome } from './lib/chrome.mjs';

const CHROME = findChrome();
const PORT = Number(process.argv[2] ?? 3111);
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const work = mkdtempSync(join(tmpdir(), 'kiln-tour-'));

/**
 * Enough environment for `next start` to boot, and no more.
 *
 * Every value is unreachable on purpose. `/onboarding` is the one route that must render
 * for a stranger with no session and no database — it reads auth inside a try/catch and
 * treats anonymous as the expected case — so a server that can reach nothing is the honest
 * environment to test it in, not a limitation of the harness.
 */
const ENV = {
  ...process.env,
  APP_URL: BASE,
  WEBHOOK_CALLBACK_BASE_URL: 'https://ci.invalid',
  ALLOWED_EMAIL: 'ci@ci.invalid',
  NEXT_PUBLIC_SUPABASE_URL: 'https://ci.invalid',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'ci',
  SUPABASE_SERVICE_ROLE_KEY: 'ci',
  STORAGE_DRIVER: 'supabase-storage',
  SUPABASE_STORAGE_BUCKET: 'ci',
  SUPABASE_S3_ACCESS_KEY_ID: 'ci',
  SUPABASE_S3_SECRET_ACCESS_KEY: 'ci',
  SUPABASE_S3_REGION: 'us-east-1',
  TRIGGER_PROJECT_REF: 'proj_ci',
  TRIGGER_SECRET_KEY: 'tr_ci',
  ANTHROPIC_API_KEY: 'ci',
  VIDEO_DRIVER: 'none',
  USD_INR_RATE: '88.5',
  HIGGSFIELD_API_KEY: 'ci',
  HIGGSFIELD_API_SECRET: 'ci',
  HIGGSFIELD_WEBHOOK_SECRET: 'ci-placeholder-secret-at-least-32-chars',
};

// ── Driving a real page ─────────────────────────────────────────────────────
//
// Over the DevTools protocol, not `--dump-dom` against a saved copy of the HTML.
//
// The saved-copy approach was tried first and is worth recording as a dead end, because it
// looks like it works: fetch the page, append a probe script, write it to a file, load the
// file. What it actually produces is a page that renders and never hydrates — Next's
// bundles load from the origin, the document does not, and clicking Next does nothing. The
// harness then reports that the backdrop is missing and the copy will not advance, which is
// true of the harness and false of the application. A test that fails for its own reasons
// is worse than no test, so: the browser opens the real URL, and the probe arrives down the
// wire afterwards.
//
// Node 22 has a WebSocket client built in, so this needs no dependency.

/**
 * Every await in this file is bounded, and that is a repair rather than a precaution.
 *
 * This harness hung on a GitHub runner and took four consecutive CI runs to the 6-hour job
 * timeout with it. Every other step passed; this one started and never returned, so the
 * runs read as `cancelled` rather than `failed` and nothing pointed at the cause.
 *
 * Three awaits could not finish: the websocket `open` event (a socket that neither opens
 * nor errors waits for ever), each CDP round trip (a browser that stops answering is
 * indistinguishable from one that is slow), and the in-page probe — which waits on
 * `requestAnimationFrame`, and rAF does not necessarily fire in a headless browser with no
 * compositor. The last is the likely root; the other two are why nobody could tell.
 *
 * Rather than guess which, all three are bounded and each says which one expired. A harness
 * that cannot finish must fail, because a hang is the one outcome that reports nothing.
 */
const DEADLINE_MS = 30_000;

function deadline(promise, what, ms = DEADLINE_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms: ${what}`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

let msgId = 0;
function cdp(ws, method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const cdpBounded = (ws, method, params, sessionId) =>
  deadline(cdp(ws, method, params, sessionId), `CDP ${method}`);

async function evaluate(ws, expression) {
  const r = await cdpBounded(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'evaluation threw');
  }
  return r.result.value;
}

/**
 * The probe. Runs inside the real page, reads the real components.
 *
 * The `readPixels` call is the load-bearing one. A canvas of the right size proves the
 * element mounted; distinct pixel values prove the renderer ran a frame, which is the
 * difference between "three.js constructed" and "the scene drew".
 */
function probeScript({ loseContext = false, advance = 0 } = {}) {
  return `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // rAF does not necessarily fire in a headless browser with no compositor, and an
  // unresolved rAF here is what took four CI runs to the six-hour job timeout. Falling back
  // to a timer keeps the read late enough to be a painted frame and guarantees it happens.
  const frame = () =>
    new Promise((resolve) => {
      let done = false;
      const go = () => { if (!done) { done = true; resolve(); } };
      requestAnimationFrame(go);
      setTimeout(go, 250);
    });
  const out = { steps: [] };
  // Long enough for the eased camera to arrive. Measuring mid-transition would report a
  // frame nobody ever looks at, and the contrast numbers below would move run to run.
  await sleep(1600);

  ${
    advance > 0
      ? `for (let i = 0; i < ${advance}; i++) {
           const next = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Next');
           if (next) next.click();
           await sleep(320);
         }`
      : ''
  }

  const backdrop = document.querySelector('[role="presentation"][aria-hidden="true"]');
  const canvas = backdrop ? backdrop.querySelector('canvas') : null;
  out.hasBackdrop = !!backdrop;
  out.hasCanvas = !!canvas;

  if (canvas) {
    const r = canvas.getBoundingClientRect();
    out.canvasWidth = Math.round(r.width);
    out.canvasHeight = Math.round(r.height);
    out.coversViewport = r.width >= window.innerWidth - 1 && r.height >= window.innerHeight - 1;

    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    out.contextAlive = !!gl && !gl.isContextLost();

    if (gl) {
      // preserveDrawingBuffer is off, so the buffer is only readable inside a frame. Doing
      // the read in rAF is what makes this see what was actually painted rather than a
      // cleared buffer.
      const px = await new Promise((resolve) => {
        frame().then(() => {
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const seen = new Set();
          let painted = 0;
          // Where the scene actually landed, in CSS pixels. The contrast ratio says the
          // words survive the backdrop; this says where the backdrop is, which is what
          // distinguishes "clear of the text" from "off the bottom of the screen" — two
          // states that produce identical contrast numbers and could not be less alike.
          let minY = Infinity, maxY = -1, minX = Infinity, maxX = -1;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              if (buf[(y * w + x) * 4 + 3] === 0) continue;
              painted++;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
          for (let i = 0; i < buf.length; i += 4 * 97) {
            seen.add(buf[i] + ',' + buf[i + 1] + ',' + buf[i + 2] + ',' + buf[i + 3]);
          }
          const sy = window.innerHeight / h, sx = window.innerWidth / w;
          resolve({
            distinct: seen.size,
            painted: painted / (w * h),
            // GL origin is bottom-left, CSS is top-left, so the extremes swap.
            box: maxY < 0 ? null : {
              top: Math.round((h - maxY) * sy),
              bottom: Math.round((h - minY) * sy),
              left: Math.round(minX * sx),
              right: Math.round(maxX * sx),
            },
            w, h,
          });
        });
      });
      out.distinctColours = px.distinct;
      out.paintedFraction = Math.round(px.painted * 1000) / 1000;
      out.drawingBuffer = px.w + 'x' + px.h;
      out.paintedBox = px.box;
      out.viewport = { w: window.innerWidth, h: window.innerHeight };
      const p = document.querySelector('h1 + p');
      out.textBottom = p ? Math.round(p.getBoundingClientRect().bottom) : null;

      // ── What the pixel count does not tell you ──────────────────────────
      //
      // "More than one colour" says the renderer ran. It says nothing about whether the
      // result is readable, and the first version of this scene passed that check while
      // putting a solid amber box behind a paragraph.
      //
      // So this composites the scene over the page background under the *actual* heading
      // and the *actual* paragraph and computes the WCAG contrast ratio against their
      // *actual* computed colour. Not a proxy for legibility — the measurement the
      // success criterion names.
      // The token layer emits oklch(), so a regex over the computed value reads 0.145 as a
      // red channel and every ratio comes out 1.00. Round-tripping through a 2D context
      // makes the browser do the colour-space conversion, which is the only version of
      // this that stays correct the next time the palette changes notation.
      const swatch = document.createElement('canvas');
      swatch.width = swatch.height = 1;
      const swatchCtx = swatch.getContext('2d');
      const parse = (css) => {
        swatchCtx.clearRect(0, 0, 1, 1);
        swatchCtx.fillStyle = css;
        swatchCtx.fillRect(0, 0, 1, 1);
        const d = swatchCtx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const lum = ([r, g, b]) => {
        const f = (v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (a, b) => {
        const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
        return (hi + 0.05) / (lo + 0.05);
      };

      const pageBg = parse(getComputedStyle(document.body).backgroundColor);

      out.contrast = await new Promise((resolve) => {
        frame().then(() => {
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          const sx = w / window.innerWidth, sy = h / window.innerHeight;
          const result = {};

          for (const [key, sel] of [['heading', 'h1'], ['body', 'h1 + p']]) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const box = el.getBoundingClientRect();
            const fg = parse(getComputedStyle(el).color);
            let worst = Infinity;

            for (let y = Math.max(0, box.top); y < box.bottom; y += 2) {
              for (let x = Math.max(0, box.left); x < box.right; x += 2) {
                // GL origin is bottom-left; CSS is top-left.
                const px2 = Math.round(x * sx);
                const py = Math.round((window.innerHeight - y) * sy);
                if (px2 < 0 || py < 0 || px2 >= w || py >= h) continue;
                const i = (py * w + px2) * 4;
                // The context is premultiplied, so the sampled RGB is already scaled by
                // its own alpha and only the background's share has to be added back.
                const a = buf[i + 3] / 255;
                const over = [
                  buf[i] + pageBg[0] * (1 - a),
                  buf[i + 1] + pageBg[1] * (1 - a),
                  buf[i + 2] + pageBg[2] * (1 - a),
                ];
                worst = Math.min(worst, ratio(fg, over));
              }
            }
            result[key] = Math.round(worst * 100) / 100;
          }
          resolve(result);
        });
      });
    }

    ${
      loseContext
        ? `const ext = (canvas.getContext('webgl2') || canvas.getContext('webgl')).getExtension('WEBGL_lose_context');
           out.canForceLoss = !!ext;
           if (ext) { ext.loseContext(); await sleep(700); }
           const after = document.querySelector('[role="presentation"][aria-hidden="true"]');
           out.backdropAfterLoss = !!after;`
        : ''
    }
  }

  // The tour itself, read the same way a person would: is the heading there, are the
  // controls there, and is the copy the copy.
  const h1 = document.querySelector('h1');
  out.heading = h1 ? h1.textContent.trim() : null;
  out.buttons = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean);
  out.bodyLength = (document.body.innerText || '').length;
  out.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  return out;
})()
`;
}

let debugPort = PORT + 500;

async function run(label, { flags = [], loseContext = false, advance = 0, viewport = '1280,900' } = {}) {
  const port = ++debugPort;
  const profile = join(work, `profile-${label}`);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--hide-scrollbars',
      '--no-first-run',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      // No GPU in a container. SwiftShader is the software path a blocklisted or
      // battery-throttled GPU would take anyway, so this is the fallback under test.
      '--enable-unsafe-swiftshader',
      `--window-size=${viewport}`,
      ...flags,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  let ws;
  try {
    let target;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/new?${BASE}/onboarding`, {
          method: 'PUT',
        });
        if (r.ok) {
          target = await r.json();
          break;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!target) throw new Error(`chromium never opened a devtools port for "${label}"`);

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await deadline(
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('devtools socket refused')), {
          once: true,
        });
      }),
      'the devtools websocket never opened',
      15_000,
    );

    await cdpBounded(ws, 'Runtime.enable');

    // Hydration, not merely load. `document.readyState` goes complete while React is still
    // catching up, and every interactive assertion below would then race it.
    for (let i = 0; i < 80; i++) {
      const ready = await evaluate(
        ws,
        `document.readyState === 'complete' && !!document.querySelector('button')`,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    return await evaluate(ws, probeScript({ loseContext, advance }));
  } finally {
    try {
      ws?.close();
    } catch {
      // Already gone.
    }
    chrome.kill('SIGKILL');
  }
}

// ── Boot the server ─────────────────────────────────────────────────────────
let server;
async function start() {
  server = spawn('npx', ['next', 'start', '-p', String(PORT)], {
    env: ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  server.stdout.on('data', (d) => log.push(d.toString()));
  server.stderr.on('data', (d) => log.push(d.toString()));

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/onboarding`);
      if (r.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`server did not answer on ${BASE} in 30s:\n${log.join('')}`);
}

function stop() {
  if (server && !server.killed) server.kill('SIGTERM');
  rmSync(work, { recursive: true, force: true });
}
process.on('exit', stop);
process.on('SIGINT', () => process.exit(130));

try {
  readFileSync('.next/BUILD_ID', 'utf8');
} catch {
  console.error('\nNo build. Run `pnpm build` first — this drives the production server,\n' +
                'and a dev server would prove that the dev server works.\n');
  process.exit(2);
}

console.log('\nThe tour, in a real browser\n');

await start();

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. The backdrop mounts and paints\n');
{
  const r = await run('default');

  if (r.hasCanvas) ok('a WebGL canvas is on the page', `${r.canvasWidth}×${r.canvasHeight} css px`);
  else bad('a WebGL canvas is on the page', 'the probe found the backdrop but no canvas');

  if (r.coversViewport) ok('  · full-bleed, not confined to the text column', r.drawingBuffer);
  else bad('  · full-bleed, not confined to the text column', `${r.canvasWidth}×${r.canvasHeight}`);

  if (r.contextAlive) ok('  · with a live context');
  else bad('  · with a live context');

  // The assertion that separates "it initialised" from "it drew". A cleared-only buffer has
  // one colour; eleven boxes at three brightnesses over a transparent clear has many.
  // Two numbers rather than one. "Distinct colours" alone rose and fell with how far the
  // camera had eased when the sample was taken, which made it a timing measurement wearing
  // a rendering assertion's clothes. The painted fraction is what actually distinguishes a
  // drawn scene from a cleared buffer.
  if (r.paintedFraction > 0.005 && r.distinctColours > 4) {
    ok('the renderer ran a frame', `${(r.paintedFraction * 100).toFixed(1)}% of the buffer painted, ${r.distinctColours} colours`);
  } else {
    bad('the renderer ran a frame', `${(r.paintedFraction * 100).toFixed(1)}% painted — a cleared buffer, not a scene`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
//
// The section that exists because the scene shipped wrong once.
//
// Every beat, not just the first: the failure was a close camera on one step, and a check
// that only looked at step one would have reported the scene as fine while the screen it
// was actually wrong on was three clicks away.
//
// WCAG 1.4.3: 4.5:1 for body text, 3:1 for large text. The heading is 20px semibold, which
// is under the 24px large-text threshold, so it is held to 4.5 as well — the looser bound
// is not available and taking it would be the kind of rounding that produces the screenshot
// this section came from.
console.log('\n2. The words stay readable over it, on every step\n');
{
  const MIN = 4.5;

  // The last entry is the case a desktop screenshot cannot show. At 390×740 the text column
  // takes the whole viewport and the vertical room between the paragraph and the controls
  // collapses, which is precisely where a track positioned by "18% below frame centre"
  // could arrive back on top of the words. The refusal beat is the one measured because it
  // has the closest camera and the brightest material.
  const CASES = [
    ...[0, 1, 2, 3, 4].map((advance) => ({ advance, viewport: '1280,900', where: 'desktop' })),
    { advance: 2, viewport: '390,740', where: 'narrow' },
  ];

  for (const [i, kase] of CASES.entries()) {
    const step = kase.advance;
    const r = await run(`contrast-${i}`, { advance: step, viewport: kase.viewport });
    if (!r.contrast) {
      bad(`${kase.where} step ${step + 1}: contrast measured`, 'no canvas — nothing was composited');
      continue;
    }
    const { heading, body } = r.contrast;
    const worst = Math.min(heading, body);
    const label = `${kase.where} step ${step + 1} — ${r.heading.slice(0, 30)}…`;

    // Both directions. Legibility alone is satisfied by drawing nothing, and the first
    // attempt at fixing the collision did exactly that — pushed the whole track off the
    // bottom of the frame, measured 9.58:1 on every step, and shipped a blank screen. A
    // one-sided check would have called that a pass.
    // On screen, not merely painted. The canvas is the size of the viewport, so geometry
    // rendered below the bottom of the frustum is simply absent — and absent measures as a
    // perfect contrast score, which is exactly how the first correction to this scene got
    // 9.58:1 on every step while showing nothing at all.
    const box = r.paintedBox;
    const onScreen =
      box && box.top < r.viewport.h - 8 && box.bottom > 8 && box.bottom - box.top > 16;

    if (r.paintedFraction < 0.004 || !onScreen) {
      bad(
        label,
        `${(r.paintedFraction * 100).toFixed(2)}% painted, box ${JSON.stringify(box)} in a ` +
          `${r.viewport.w}×${r.viewport.h} viewport — the scene is off-screen or too faint ` +
          'to see. Legible because absent is not the same as legible.',
      );
    } else if (worst >= MIN) {
      ok(
        label,
        `${worst.toFixed(2)}:1 worst pixel, ${(r.paintedFraction * 100).toFixed(1)}% painted, ` +
          `y ${box.top}–${box.bottom} of ${r.viewport.h} (text ends at ${r.textBottom})`,
      );
    } else {
      bad(
        label,
        `${worst.toFixed(2)}:1 — below ${MIN}:1. The backdrop is bright enough under the ` +
          'text to be the reason somebody cannot read it, which is the one thing it is ' +
          'not allowed to be.',
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. The tour is the tour, with the backdrop and without it\n');
{
  const withScene = await run('with-scene');
  const reduced = await run('reduced', { flags: ['--force-prefers-reduced-motion'] });

  if (reduced.reducedMotion) ok('the reduced-motion preference is in effect for this run');
  else bad('the reduced-motion preference is in effect for this run', 'the flag did not take');

  if (!reduced.hasCanvas) ok('no canvas is created at all', 'the module is never imported');
  else bad('no canvas is created at all', 'the scene mounted despite the preference');

  if (reduced.heading && reduced.heading === withScene.heading) {
    ok('the same first step is on screen either way', reduced.heading.slice(0, 52) + '…');
  } else {
    bad('the same first step is on screen either way', `${withScene.heading} vs ${reduced.heading}`);
  }

  const sameControls = JSON.stringify(reduced.buttons) === JSON.stringify(withScene.buttons);
  if (sameControls) ok('  · and the same controls', reduced.buttons.join(', '));
  else bad('  · and the same controls', `${withScene.buttons} vs ${reduced.buttons}`);

  // Text length rather than text equality: the two runs render the same component, so a
  // difference here would mean the backdrop had somehow changed the copy — which is the
  // thing the whole no-strings-in-a-beat design exists to make impossible.
  if (reduced.bodyLength === withScene.bodyLength) ok('  · and exactly the same words');
  else bad('  · and exactly the same words', `${withScene.bodyLength} vs ${reduced.bodyLength} chars`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. A step change moves the scene, not the machinery\n');
{
  const advanced = await run('advanced', { advance: 2 });

  if (advanced.hasCanvas && advanced.contextAlive) {
    ok('the context survives stepping', 'one context for the whole tour, not one per step');
  } else {
    bad('the context survives stepping', 'the scene was torn down and rebuilt');
  }

  if (advanced.paintedFraction > 0.005) ok('  · and it is still drawing', `${(advanced.paintedFraction * 100).toFixed(1)}% painted`);
  else bad('  · and it is still drawing', `${(advanced.paintedFraction * 100).toFixed(1)}% painted`);

  if (advanced.heading && advanced.heading !== 'Kiln makes short videos, and tells you what each one cost.') {
    ok('  · while the copy advanced', advanced.heading.slice(0, 52) + '…');
  } else {
    bad('  · while the copy advanced', `still on ${advanced.heading}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. A lost context takes the backdrop away and nothing else\n');
{
  const lost = await run('lost', { loseContext: true });

  if (lost.canForceLoss) ok('the loss was forced for real', 'WEBGL_lose_context, not a simulated event');
  else bad('the loss was forced for real', 'the extension was unavailable — this proved nothing');

  if (lost.backdropAfterLoss === false) {
    ok('the backdrop is removed', 'no frozen last frame behind live text');
  } else {
    bad('the backdrop is removed', 'the canvas is still mounted showing whatever it had');
  }

  if (lost.heading) ok('the tour is unaffected', lost.heading.slice(0, 52) + '…');
  else bad('the tour is unaffected', 'the heading is gone — the loss took the page with it');

  if (lost.buttons.includes('Next') && lost.buttons.includes('Skip')) {
    ok('  · and still navigable', lost.buttons.join(', '));
  } else {
    bad('  · and still navigable', lost.buttons.join(', '));
  }
}

// ── Exit, explicitly, on both paths ─────────────────────────────────────────
//
// **This is the CI hang, and it was not the awaits.**
//
// `stop()` is registered on `process.on('exit')`, and that event never fires while a handle
// is open. The spawned `next start` child is one, so on the *success* path this file printed
// every PASS line, printed the closing summary, and then sat there until something killed
// it. The failure path called `process.exit(1)` and worked, which is why the defect only
// ever appeared when everything was fine — run 49 in CI is exactly that: 33 green steps and
// a 34th that started and never completed.
//
// Diagnosed the wrong way round first. The bounded awaits added earlier are correct and
// stay — a browser that stops answering must not wait for ever either — but they were not
// the cause, and believing they were cost a round. The tell was available the whole time:
// `timeout 280 pnpm verify:tour` exits 124, while the log it produced was entirely green.
// One more instance of the rule this same commit added to CLAUDE.md: **the exit code is the
// result; the output is a description of it.**
stop();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nThe backdrop renders, disappears when it should, and is never the reason the tour ' +
    'cannot be read.\n' +
    'What no harness can tell you: whether it looks any good. Open /onboarding.\n',
);

// Not `return`, and not falling off the end. Chromium is spawned per run() and the server
// child outlives this scope; an explicit zero is the only way this process is guaranteed to
// end rather than to linger on whatever handle is still open.
process.exit(0);
