#!/usr/bin/env node
/**
 * Measure the built CSS in a real browser. Do not assert it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this runs against
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The stylesheet Next actually emitted — `.next/static/css/*.css` — not the source tokens.
 * That distinction is the point: `clamp()`, `@theme`, the Tailwind utility generation and
 * the custom-property indirection all happen at build time, and a check that reads
 * `tokens.css` would be checking the input to a compiler rather than its output.
 *
 * Chromium, headless, via `--dump-dom`. No Playwright: it is not a dependency of this repo
 * and adding one to run a dozen `getComputedStyle` calls is not a trade worth making. The
 * page computes everything itself and writes the results into the DOM; the dump is the
 * transport.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why width sweeps rather than one measurement
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A `clamp()` misbehaves at *specific* widths — the ones where it crosses from its minimum
 * into its fluid range, or out the top. A single check at 1280px passes on a scale that is
 * broken at 320px and at 3840px. WCAG 1.4.4 (200% text) and 1.4.10 (reflow at 320 CSS px)
 * are both width-dependent for the same reason.
 *
 * Browser zoom is not emulated with a zoom setting. Zooming to 400% on a 1280px window
 * *is* a 320px CSS viewport — that is what zoom does — so the width sweep covers it, and
 * covers it more honestly than a devtools multiplier would.
 *
 * Usage: node scripts/verify-scaling.mjs
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * 320 is the 1.4.10 reflow floor and also 400% zoom on a 1280px window.
 * 640 is 200% zoom on 1280. 3840 is the display this whole feature exists for.
 */
const WIDTHS = [320, 640, 768, 1280, 1920, 2560, 3840];

/** WCAG 2.5.8. The floor is not a preference and must hold at the smallest UI scale. */
const HIT_MIN_PX = 24;
const HIT_PRIMARY_PX = 44;

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const cssDir = '.next/static/css';
let cssFile;
try {
  cssFile = readdirSync(cssDir).filter((f) => f.endsWith('.css')).sort().pop();
} catch {
  console.error('\nNo built CSS. Run `pnpm build` first — this measures the compiled output,\n' +
                'not the source tokens, and there is nothing to measure until it exists.\n');
  process.exit(2);
}
const css = readFileSync(join(cssDir, cssFile), 'utf8');

const work = mkdtempSync(join(tmpdir(), 'kiln-scaling-'));

/**
 * The probe page.
 *
 * Every element here mirrors something real: the type steps, a hit target sized the way the
 * UI-scale stepper sizes its buttons, a primary control, and a row with a fixed pixel height
 * of the kind `check:scalable-sizes` warns about — so the 1.4.12 text-spacing clip is
 * measured rather than reasoned about.
 */
const STEPS = ['3xs', '2xs', 'xs', 'sm', 'md', 'lg', 'xl'];

function page(scale, rootFontPx, textSpacing) {
  return `<!doctype html><html style="--ui-scale:${scale}${rootFontPx ? `;font-size:${rootFontPx}px` : ''}"><head>
<style>${css}</style>
${textSpacing ? `<style>
/* WCAG 1.4.12 — the exact overrides the success criterion names. */
* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
p, li { margin-bottom: 2em !important; }
</style>` : ''}
</head><body>
${STEPS.map((s) => `<div class="text-${s}" id="t-${s}">Ag</div>`).join('')}
<button id="hit" class="rounded-sm border px-3 text-xs" style="min-height:var(--hit-min)">100%</button>
<button id="primary" class="rounded-sm px-3 text-sm" style="min-height:var(--hit-primary)">Primary</button>
<div id="fixedrow" class="h-[38px] text-xs" style="overflow:hidden">A row with real text in it that must not clip</div>
<div id="spaced" class="p-4">spacing probe</div>
<pre id="out"></pre>
<script>
var out = {};
${STEPS.map((s) => `out['${s}'] = parseFloat(getComputedStyle(document.getElementById('t-${s}')).fontSize);`).join('\n')}
out.hit = document.getElementById('hit').getBoundingClientRect().height;
out.primary = document.getElementById('primary').getBoundingClientRect().height;
var fr = document.getElementById('fixedrow');
out.rowClipped = fr.scrollHeight > fr.clientHeight + 0.5;
out.pad = parseFloat(getComputedStyle(document.getElementById('spaced')).paddingTop);
out.docOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
out.innerWidth = window.innerWidth;
document.getElementById('out').textContent = 'KILN::' + JSON.stringify(out) + '::END';
</script></body></html>`;
}

function measure(width, scale, { rootFontPx = 0, textSpacing = false } = {}) {
  const file = join(work, `p-${width}-${scale}-${rootFontPx}-${textSpacing}.html`);
  writeFileSync(file, page(scale, rootFontPx, textSpacing));
  const dom = execFileSync(
    CHROME,
    [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--window-size=${width},900`,
      '--virtual-time-budget=1500',
      '--dump-dom',
      `file://${file}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const m = /KILN::(.*?)::END/s.exec(dom);
  if (!m) throw new Error(`no measurement returned at ${width}px / scale ${scale}`);
  return JSON.parse(m[1]);
}

console.log('\nDisplay scaling verification\n');
console.log(`  stylesheet ${cssFile} (${Math.round(css.length / 1024)} kB)\n`);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The type scale exists, is ordered, and moves with --ui-scale
// ═══════════════════════════════════════════════════════════════════════════

console.log('1. The scale responds to the preference\n');

const at100 = measure(1280, 1.0);
const at90 = measure(1280, 0.9);
const at150 = measure(1280, 1.5);

{
  const sizes = STEPS.map((s) => at100[s]);
  const ordered = sizes.every((v, i) => i === 0 || v > sizes[i - 1]);
  if (ordered) ok('seven steps, strictly ascending', sizes.map((v) => v.toFixed(2)).join(' < '));
  else bad('seven steps, strictly ascending', sizes.join(', '));
}

for (const [label, m, factor] of [['90%', at90, 0.9], ['150%', at150, 1.5]]) {
  const worst = STEPS.reduce((w, s) => {
    const expected = at100[s] * factor;
    return Math.max(w, Math.abs(m[s] - expected) / expected);
  }, 0);
  if (worst < 0.01) ok(`every step scales at ${label}`, `max deviation ${(worst * 100).toFixed(2)}%`);
  else bad(`every step scales at ${label}`, `max deviation ${(worst * 100).toFixed(1)}%`);
}

{
  // The preference must move spacing too, or text grows inside unchanged gutters.
  const p100 = at100.pad, p150 = at150.pad;
  if (Math.abs(p150 - p100 * 1.5) < 0.5) ok('spacing scales with the preference', `${p100}px → ${p150}px`);
  else bad('spacing scales with the preference', `${p100}px → ${p150}px, expected ${p100 * 1.5}px`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. The rem term — the WCAG 1.4.4 trap
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n2. Every size carries a rem term\n');

{
  // Doubling the root font size must roughly double the text. A clamp whose preferred value
  // is viewport-units-only would not move at all, which is the 1.4.4 failure.
  const doubled = measure(1280, 1.0, { rootFontPx: 32 });
  const unmoved = STEPS.filter((s) => doubled[s] < at100[s] * 1.3);
  if (unmoved.length === 0) {
    const ratios = STEPS.map((s) => (doubled[s] / at100[s]).toFixed(2));
    ok('root font size 16→32 enlarges every step', `ratios ${ratios.join(', ')}`);
  } else {
    bad(
      'root font size 16→32 enlarges every step',
      `${unmoved.join(', ')} barely moved — those are viewport-unit-only and fail WCAG 1.4.4`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. The width sweep — where clamps actually break
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n3. Across the width sweep\n');

const sweep = WIDTHS.map((w) => ({ w, m: measure(w, 1.0) }));

{
  const rows = sweep.map(({ w, m }) => `${w}px:${m.xs.toFixed(2)}`);
  console.log(`        text-xs across widths — ${rows.join('  ')}`);

  for (const step of STEPS) {
    const values = sweep.map(({ m }) => m[step]);
    const min = Math.min(...values), max = Math.max(...values);
    const ratio = max / min;
    if (ratio > 2.5) {
      bad(`${step}: max ≤ 2.5 × min`, `${min.toFixed(2)}…${max.toFixed(2)} is ${ratio.toFixed(2)}×`);
    }
    // Monotonic: a step must not shrink as the viewport grows.
    const monotonic = values.every((v, i) => i === 0 || v >= values[i - 1] - 0.01);
    if (!monotonic) bad(`${step}: never shrinks as the viewport grows`, values.map((v) => v.toFixed(2)).join(' '));
  }
  ok('every step stays within 2.5× and never shrinks with width');
}

{
  const narrow = sweep.find((s) => s.w === 320).m;
  if (!narrow.docOverflow) ok('WCAG 1.4.10 — no horizontal overflow at 320 CSS px');
  else bad('WCAG 1.4.10 — no horizontal overflow at 320 CSS px', 'the document scrolls sideways');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Target size at the SMALLEST scale — WCAG 2.5.8
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n4. Hit targets at the smallest UI scale\n');

{
  if (at90.hit >= HIT_MIN_PX - 0.5) {
    ok(`minimum target holds at 90%`, `${at90.hit.toFixed(1)}px ≥ ${HIT_MIN_PX}px`);
  } else {
    bad(`minimum target holds at 90%`, `${at90.hit.toFixed(1)}px < ${HIT_MIN_PX}px — --hit-min is being scaled and must not be`);
  }

  if (at90.primary >= HIT_PRIMARY_PX - 0.5) {
    ok(`primary target holds at 90%`, `${at90.primary.toFixed(1)}px ≥ ${HIT_PRIMARY_PX}px`);
  } else {
    bad(`primary target holds at 90%`, `${at90.primary.toFixed(1)}px < ${HIT_PRIMARY_PX}px`);
  }

  if (at150.primary >= at100.primary) ok('primary target grows with the preference', `${at100.primary.toFixed(0)}px → ${at150.primary.toFixed(0)}px`);
  else bad('primary target grows with the preference');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Text spacing — WCAG 1.4.12
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n5. WCAG 1.4.12 text spacing\n');

{
  const spaced = measure(1280, 1.0, { textSpacing: true });
  if (!spaced.rowClipped) {
    ok('a fixed-height row survives the 1.4.12 overrides');
  } else {
    bad(
      'a fixed-height row survives the 1.4.12 overrides',
      'content clips at line-height 1.5 — a fixed px height on a row holding text cannot pass',
    );
  }
}

console.log('\n6. What this could not measure\n');
console.log('  DevTools DPR emulation does not reproduce the case this feature exists for:');
console.log('  a 3840px CSS viewport at devicePixelRatio 1. Emulating DPR 2 at 1920 CSS px is');
console.log('  a different situation with the same pixel count, and it looks fine either way.');
console.log('  The sweep above renders at a real 3840px CSS width, which is closer — but it');
console.log('  still cannot know how far the monitor is from your face.\n');
console.log('  Check by hand on the 4K monitor, at 100% OS scaling:');
console.log('    · devicePixelRatio in the console reads 1, and innerWidth reads ~3840');
console.log('    · the default 100% is legible at your actual seating distance');
console.log('    · 125% and 150% do not overflow the sidebar or clip the shot strip');
console.log('    · at 90%, every button is still comfortably clickable\n');

if (failures === 0) console.log('Scaling verified against the built stylesheet.\n');
else console.log(`${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
