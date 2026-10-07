#!/usr/bin/env node
/**
 * probe:frame — render single 1080×1920 frames of the 3D explainer's graphics layer (0052)
 * through the real Remotion bundle and headless Chromium, to LOOK at them. Spends nothing.
 *
 * The four frames are the four kinds of beat the format spec draws: a numbered attempt (badge),
 * its verdict (✗ with a sub-line), a cutaway with callouts, and a mechanism beat with a meter —
 * each with a 2–4-word caption whose keyword is coloured by its role. The picture underneath
 * is the image you pass (a real 3D still, for the handover) or a plain grey stand-in.
 *
 * Usage: node scripts/engineered-frame.mjs <out-dir> [picture.png|jpg]
 *   REMOTION_BROWSER_EXECUTABLE overrides the headless shell path.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const [outDir, picture] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node scripts/engineered-frame.mjs <out-dir> [picture]');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });
let img = picture;
if (!img) {
  img = join(outDir, 'stand-in.png');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xD8DCE2:s=720x1280', '-frames:v', '1', img]);
}
const mime = /\.jpe?g$/i.test(img) ? 'image/jpeg' : /\.webp$/i.test(img) ? 'image/webp' : 'image/png';
const url = `data:${mime};base64,${(await readFile(img)).toString('base64')}`;

const { bundle } = await import('@remotion/bundler');
const { renderStill, selectComposition } = await import('@remotion/renderer');
const serveUrl = await bundle({ entryPoint: join(process.cwd(), 'src/remotion/index.ts') });
const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';

const W = 1080;
const H = 1920;
// The assembler's safe box (SAFE_AREAS.shorts_9x16: top .08, bottom .20, left .05, right .14).
const safeBox = { x: Math.round(W * 0.05), y: Math.round(H * 0.08), width: Math.round(W * (1 - 0.05 - 0.14)), height: Math.round(H * (1 - 0.08 - 0.2)) };
const cue = (text, keywordIndex, role) => {
  const words = text.split(' ').map((w, i) => ({ w, start: i * 0.3, end: i * 0.3 + 0.28 }));
  return { startS: 0, endS: 10, text, words, ...(keywordIndex === null ? {} : { keyword: { index: keywordIndex, role } }) };
};
const FRAMES = [
  { name: '1-badge', g: { badge: { n: 2, label: 'DROP HOOK' } }, cue: cue('A HOOK THAT DROPS', 1, 'mechanism') },
  { name: '2-verdict', g: { verdict: { pass: false, text: 'LETS GO', sub: 'on curves and bumps' } }, cue: cue('IT BOUNCES OFF', 1, 'danger') },
  { name: '3-callouts', g: { callouts: [{ label: 'KNUCKLE', x: 0.4, y: 0.45 }, { label: 'LOCK BLOCK', x: 0.62, y: 0.56 }] }, cue: cue('THE KNUCKLE PUSHES', 1, 'mechanism') },
  { name: '4-meter', g: { verdict: { pass: true, text: 'LOCKS ITSELF', sub: 'nobody in the gap' }, meters: [{ label: 'PULL IT HOLDS', from: 0.1, to: 0.85, unit: '≈ 350 tonnes' }] }, cue: cue('NOBODY STANDS BETWEEN', 0, 'outcome') },
];
for (const f of FRAMES) {
  const props = {
    layer: 'composite',
    shots: [{ type: 'still', url, camera: 'static', accent: '#FFD23F', seed: 1, frames: 60 }],
    audioUrl: null,
    musicUrl: null,
    cues: [f.cue],
    hook: null,
    safeBox,
    captionStyle: 'engineered',
    graphics: [{ from: 0, frames: 60, g: f.g }],
  };
  const composition = await selectComposition({ serveUrl, id: 'bureau-video', inputProps: props, browserExecutable });
  const output = join(outDir, `${f.name}.png`);
  await renderStill({ composition: { ...composition, width: W, height: H, fps: 30, durationInFrames: 60 }, serveUrl, inputProps: props, frame: 45, output, browserExecutable });
  console.log(`wrote ${output}`);
}
