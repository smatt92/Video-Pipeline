#!/usr/bin/env node
/**
 * The tour's copy and the tour's scene do not drift apart.
 *
 * PROVES:  every step has a beat and every beat has a step; the scene addresses only stages
 *          that exist; the track it draws is the pipeline's eleven and not some other
 *          number; and — the one that matters — the scene has no way to put words on
 *          screen.
 *
 * The last assertion is the whole reason this file exists. `tour.ts` states the rule in
 * prose: the 3D layer may add spatial explanation and may never add a sentence the flat
 * renderer does not have. Prose rules are followed until the afternoon somebody adds a
 * label because the scene looked bare. This checks the *shape* — no string-valued field in
 * a beat, no text geometry, no font loaded — so the rule fails a build rather than a review.
 *
 * Runs without a GPU, a browser or a network, which is why it can be in `pnpm check`.
 *
 * Usage: node scripts/test-tour-scene.mjs
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;

// Importing this at all is the first assertion: scene.ts throws at module load when a step
// has no beat or a beat has no step, exactly like tour.ts throws past five steps.
const { STAGES, BEATS, stageX, stageHeight } = require(`${BUILD}/onboarding/scene.js`);
const { TOUR } = require(`${BUILD}/onboarding/tour.js`);

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

console.log('\nThe tour scene\n');

console.log('1. Copy and scene stay in step\n');
{
  // The module-load guard already ran. Restating it here means the output says what was
  // proven rather than merely not crashing.
  const stepIds = TOUR.map((s) => s.id);
  const beatIds = Object.keys(BEATS);
  const missing = stepIds.filter((id) => !beatIds.includes(id));
  const orphaned = beatIds.filter((id) => !stepIds.includes(id));

  if (missing.length === 0) ok('every step has a beat', `${stepIds.length} steps`);
  else bad('every step has a beat', missing.join(', '));

  if (orphaned.length === 0) ok('every beat has a step');
  else bad('every beat has a step', orphaned.join(', '));

  // Order matters as much as membership. A beat keyed to a renamed step would pass the
  // membership check above while pointing the camera at the wrong stage.
  const ordered = beatIds.join(',') === stepIds.join(',');
  if (ordered) ok('  · and in the same order', stepIds.join(' → '));
  else bad('  · and in the same order', `${beatIds.join(',')} vs ${stepIds.join(',')}`);
}

console.log('\n2. The scene addresses stages that exist\n');
{
  const valid = new Set(STAGES.map((s) => s.n));
  const bogus = [];

  for (const [id, beat] of Object.entries(BEATS)) {
    for (const n of Object.keys(beat.lit)) {
      if (!valid.has(Number(n))) bogus.push(`${id}.lit[${n}]`);
    }
    if (beat.pulseStopsAt !== null && !valid.has(beat.pulseStopsAt)) {
      bogus.push(`${id}.pulseStopsAt=${beat.pulseStopsAt}`);
    }
    for (const n of beat.flow ?? []) {
      if (!valid.has(n)) bogus.push(`${id}.flow=${n}`);
    }
    if (beat.ledger < 0 || beat.ledger > 1) bogus.push(`${id}.ledger=${beat.ledger}`);
  }

  if (bogus.length === 0) ok('no beat points at a stage that is not on the track');
  else bad('no beat points at a stage that is not on the track', bogus.join(', '));

  if (STAGES.length === 11) ok('the track is the pipeline', '11 stages, per ARCHITECTURE §4');
  else bad('the track is the pipeline', `${STAGES.length} stages, expected 11`);

  // The layout functions are what the renderer positions by. A track that collapses to a
  // point or inverts would draw and be silently wrong, which is the same failure class as
  // a render with the wrong duration.
  const xs = STAGES.map((s) => stageX(s.n));
  const monotonic = xs.every((x, i) => i === 0 || x > xs[i - 1]);
  const centred = Math.abs(xs[0] + xs[xs.length - 1]) < 1e-9;
  if (monotonic && centred) ok('the track runs left to right and is centred on zero');
  else bad('the track runs left to right and is centred on zero', xs.join(', '));

  if (STAGES.every((s) => stageHeight(s.n) > 0)) ok('every stage has a positive height');
  else bad('every stage has a positive height');
}

console.log('\n3. The scene cannot say anything\n');
{
  // No string-valued field anywhere in a beat. `lit` holds moods, which are a closed set of
  // enum values the renderer maps to colours — checked explicitly rather than exempted,
  // because "it is only an enum" is how the first label would arrive.
  const MOODS = new Set(['done', 'active', 'held']);
  const strings = [];

  for (const [id, beat] of Object.entries(BEATS)) {
    for (const [key, value] of Object.entries(beat)) {
      if (key === 'lit') {
        for (const [n, mood] of Object.entries(value)) {
          if (!MOODS.has(mood)) strings.push(`${id}.lit[${n}]="${mood}"`);
        }
        continue;
      }
      if (typeof value === 'string') strings.push(`${id}.${key}="${value}"`);
    }
  }

  if (strings.length === 0) {
    ok('no beat carries text', 'positions, moods and numbers only');
  } else {
    bad(
      'no beat carries text',
      `${strings.join(', ')} — the flat renderer cannot show this, so the two versions now ` +
        'differ in content rather than in arrangement',
    );
  }

  // And the renderer has no machinery to draw text even if a beat did carry some.
  const src = readFileSync('src/components/onboarding/tour-scene.tsx', 'utf8');
  const textApis = ['TextGeometry', 'FontLoader', 'CanvasTexture', 'fillText', 'Sprite'];
  const found = textApis.filter((api) => src.includes(api));

  if (found.length === 0) ok('the renderer loads no font and draws no glyph');
  else bad('the renderer loads no font and draws no glyph', found.join(', '));
}

console.log('\n4. The loop can be stopped\n');
{
  // Not a format check dressed up as one: these three are the difference between a backdrop
  // and a battery complaint, and each was a deliberate decision with a comment attached. A
  // refactor that drops one would leave the scene working perfectly on the machine of
  // whoever did the refactoring.
  const src = readFileSync('src/components/onboarding/tour-scene.tsx', 'utf8');
  const gate = readFileSync('src/components/onboarding/tour-backdrop.tsx', 'utf8');

  const checks = [
    ['reduced motion is asked in JS', gate.includes('prefers-reduced-motion')],
    ['  · and re-asked when it changes', gate.includes("addEventListener('change'")],
    ['a hidden tab cancels the frame', src.includes("'visibilitychange'")],
    ['a lost context is caught', src.includes("'webglcontextlost'")],
    ['  · and the frozen last frame prevented', src.includes('preventDefault')],
    ['the context is handed back on unmount', src.includes('forceContextLoss')],
    ['the module is client-only', gate.includes('ssr: false')],
  ];

  for (const [label, passed] of checks) {
    if (passed) ok(label);
    else bad(label);
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log('\nThe scene tracks the copy, and adds arrangement rather than argument.\n');
