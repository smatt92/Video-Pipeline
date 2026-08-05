#!/usr/bin/env node
/**
 * The final composition, rendered — the half of stage 7 that produces a file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this drives that `verify:assemble` cannot
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `verify:assemble` proves the rough cut: clips concatenated by ffmpeg. §9 of it proves the
 * composition *plan* — cues, hook window, safe box, frame count — as pure arithmetic.
 *
 * Neither renders anything. This does: a real Chromium, a real Remotion bundle, real clips
 * over real HTTP, and a real MP4 measured afterwards. It exists because all three duration
 * bugs this project has shipped came out of this path and every one produced a file that
 * plays and is wrong — the failure nothing downstream can detect.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The browser, and why this now runs in CI
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Remotion drives Chromium in *old* headless mode, which recent Chrome removed. This
 * container has `chromium_headless_shell`, the standalone implementation of it; a GitHub
 * runner ships Chrome, which refuses with "Old Headless mode has been removed".
 *
 * So the browser is resolved in two steps. A local old-headless-capable binary if one exists
 * — instant, no download, and the case in this container and in CI, where the workflow
 * installs `chrome-headless-shell` and exports `REMOTION_BROWSER_EXECUTABLE`. Otherwise
 * `ensureBrowser()`, Remotion's own version-matched installer, as a fallback.
 *
 * The CI step is explicit rather than leaning on that fallback, for a reason worth stating:
 * **the fallback could not be executed here.** This container's egress allowlist refuses
 * `remotion.media`, so the download 403s. An explicit install step is visible in the step
 * list, fails as itself rather than inside a harness, and does not depend on a code path
 * nobody has run.
 *
 * **It fails rather than skips** if neither works. A render harness that quietly passes on a
 * machine that never rendered anything is the guard-that-runs-nowhere failure wearing a skip,
 * and this path is the one the whole product exists to produce.
 *
 * Usage: node scripts/verify-render.mjs
 */

import { execFile } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;

let failures = 0;
const ok = (name, detail) => console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ── A browser Remotion can actually drive ───────────────────────────────────
//
// The headless shell first: it is the old-headless implementation Remotion needs. Refusing
// is the correct outcome when neither exists — see the header.
function findRenderBrowser() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const candidates = [
    process.env.REMOTION_BROWSER_EXECUTABLE,
    `${root}/chromium_headless_shell-1194/chrome-linux/headless_shell`,
    '/usr/bin/chrome-headless-shell',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

let browserExecutable = findRenderBrowser();
let browserSource = 'local';

if (!browserExecutable) {
  // Remotion's own installer. Throwing here is the correct outcome — the catch re-raises
  // with the reason, rather than turning a missing browser into a silent pass.
  browserSource = 'downloaded by Remotion';
  try {
    const { ensureBrowser } = await import('@remotion/renderer');
    await ensureBrowser();
    browserExecutable = undefined; // Remotion uses the one it just placed.
  } catch (err) {
    console.error(
      '\nNo old-headless-capable browser, and Remotion could not fetch one.\n\n' +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        'Failing rather than skipping: a render harness that passes without rendering is\n' +
        'worse than one that is honestly unavailable.\n',
    );
    process.exit(1);
  }
}

console.log(`\nFinal composition render\n\n  browser  ${browserExecutable ?? browserSource}\n`);

const work = await mkdtemp(join(tmpdir(), 'kiln-verify-render-'));

// ── Two synthetic clips, two seconds each ───────────────────────────────────
const clips = [];
for (let i = 0; i < 2; i += 1) {
  const path = join(work, `clip${i}.mp4`);
  await run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc=size=540x960:rate=30:duration=2`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path,
  ]);
  clips.push(path);
}

// Served over HTTP, because that is the only thing Remotion's asset downloader accepts —
// and it is what production does anyway, where clips are presigned GETs from the bucket.
const server = createServer((req, res) => {
  const i = Number((req.url ?? '').replace('/clip', '').replace('.mp4', ''));
  const path = clips[i];
  if (!path) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': statSync(path).size });
  createReadStream(path).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const clipBase = `http://127.0.0.1:${server.address().port}`;

const { planComposition } = await import(`${BUILD}/assemble/composition.js`);
const { renderComposition } = await import(`${BUILD}/assemble/render.js`);

// Eight words over four seconds. Authored rather than synthesised — this harness is about
// the render, and fixing the timings is what lets the frame count be asserted exactly.
const words = Array.from({ length: 8 }, (_, i) => ({
  w: `word${i}`,
  start: i * 0.5,
  end: i * 0.5 + 0.45,
}));

const planned = planComposition({
  format: 'shorts_9x16',
  width: 540,
  height: 960,
  fps: 30,
  durationS: 4,
  hook: 'The hook, on screen first',
  words,
});

if (!planned.ok) {
  bad('the plan is renderable', `${planned.code}: ${planned.detail}`);
  process.exit(1);
}
ok('the plan is renderable', `${planned.plan.durationInFrames} frames, ${planned.plan.cues.length} cues`);

// LOAD-BEARING. The safe areas are unverified against a real handset and every plan must
// say so. This asserts the flag arrives rather than that it is absent — the day somebody
// flips `verified` without measuring, this fails, which is the point.
if (planned.plan.problems.some((p) => /never been checked against a real post/.test(p))) {
  ok('the plan reports its unverified safe area', `${planned.plan.problems.length} problem(s)`);
} else {
  bad('the plan reports its unverified safe area', JSON.stringify(planned.plan.problems));
}

// ── §1. The refusals, before any render ─────────────────────────────────────
{
  const base = {
    plan: planned.plan,
    outputPath: join(work, 'never.mp4'),
    browserExecutable,
  };

  const cases = [
    ['no clips', { ...base, clipUrls: [], clipFrames: [] }, 'no_clips'],
    ['clip and frame counts disagreeing', { ...base, clipUrls: [`${clipBase}/clip0.mp4`], clipFrames: [] }, 'clip_frame_mismatch'],
    ['a filesystem path instead of a URL', { ...base, clipUrls: [clips[0], clips[1]], clipFrames: [60, 60] }, 'clip_url_not_http'],
    ['a file:// URL', { ...base, clipUrls: [`file://${clips[0]}`, `file://${clips[1]}`], clipFrames: [60, 60] }, 'clip_url_not_http'],
    ['frames not summing to the plan', { ...base, clipUrls: [`${clipBase}/clip0.mp4`, `${clipBase}/clip1.mp4`], clipFrames: [60, 30] }, 'duration_disagreement'],
  ];

  for (const [label, input, code] of cases) {
    const result = await renderComposition(input);
    if (result.ok === false && result.code === code) ok(`refuses ${label}`, code);
    else bad(`refuses ${label}`, JSON.stringify(result).slice(0, 120));
  }

  // Every one of those refused before Chromium started, which is why they are instant. A
  // render that reaches the browser and then refuses has already cost the expensive part.
  if (!existsSync(join(work, 'never.mp4'))) {
    ok('no refusal produced a file', 'nothing written');
  } else {
    bad('no refusal produced a file', 'a refusing render still wrote an output');
  }
}

// ── §2. The render itself ───────────────────────────────────────────────────
const outputPath = join(work, 'out.mp4');
const result = await renderComposition({
  plan: planned.plan,
  clipUrls: [`${clipBase}/clip0.mp4`, `${clipBase}/clip1.mp4`],
  clipFrames: [60, 60],
  outputPath,
  browserExecutable,
});

if (result.ok) {
  ok('the composition renders', `${result.frames} frames, ${result.durationS}s`);
} else {
  bad('the composition renders', `${result.code}: ${result.detail}`);
}

// ── §3. The file is what the plan said ──────────────────────────────────────
//
// LOAD-BEARING, and asserted here against ffprobe independently of what `renderComposition`
// reported about itself. Its own measurement and this one arrive by different routes: the
// function counts packets to decide whether to return ok, and this reads dimensions and the
// frame rate, which it never looked at. A render that satisfied its own check and produced
// a 1080-wide file for a 540-wide plan would pass there and fail here.
if (result.ok) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_packets',
    '-show_entries', 'stream=width,height,r_frame_rate,nb_read_packets',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    outputPath,
  ]);
  const [width, height, rate, frames] = stdout.trim().split('\n');

  const expected = [
    ['width', width, String(planned.plan.width)],
    ['height', height, String(planned.plan.height)],
    ['frame rate', rate, `${planned.plan.fps}/1`],
    ['frame count', frames, String(planned.plan.durationInFrames)],
  ];

  for (const [what, got, want] of expected) {
    if (got === want) ok(`the file's ${what} matches the plan`, got);
    else bad(`the file's ${what} matches the plan`, `got ${got}, planned ${want}`);
  }
}

// ── §4. A wrong frame count is caught ───────────────────────────────────────
//
// The accepting branch above passes on a correct render; this drives the failing one, so
// the duration assertion is known to be able to fire rather than merely to have been
// written. Simulated by claiming a plan one frame longer than the clips provide.
{
  const shortByOne = { ...planned.plan, durationInFrames: planned.plan.durationInFrames + 1 };
  const wrong = await renderComposition({
    plan: shortByOne,
    clipUrls: [`${clipBase}/clip0.mp4`, `${clipBase}/clip1.mp4`],
    clipFrames: [60, 60],
    outputPath: join(work, 'wrong.mp4'),
    browserExecutable,
  });

  if (wrong.ok === false && wrong.code === 'duration_disagreement') {
    ok('a plan the clips cannot fill is refused', wrong.code);
  } else {
    bad('a plan the clips cannot fill is refused', JSON.stringify(wrong).slice(0, 140));
  }
}

server.close();
await rm(work, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nThe final composition renders and the file is the length the plan said.\n' +
    'What this does not prove: that the captions are legible or the safe areas correct —\n' +
    'both need eyes on a real post. DECISIONS-PENDING 6.\n',
);
