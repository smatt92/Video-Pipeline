#!/usr/bin/env node
/**
 * WCAG AA for Kiln Glass, in every theme (Sahil, 08-Oct): text on glass, and black ink on
 * each of the six gradients.
 *
 * ── What it reads ────────────────────────────────────────────────────────────
 *
 * The stylesheet that ships — src/styles/tokens.css — parsed here, not a table of colours
 * copied into this file. A copy would be the tautology CLAUDE.md warns about: the test would
 * agree with itself while the CSS drifted. The one other source it reads, src/styles/themes.ts
 * (the hex labels the picker prints), is checked AGAINST the CSS, so the two cannot disagree.
 *
 * ── Worst case, not the average ──────────────────────────────────────────────
 *
 * Glass is translucent, so the background a sentence sits on depends on what is behind the
 * panel. Each check composites the panel over the graphite base PLUS the theme's brightest
 * ambient orb at its peak alpha (the centre of the radial gradient, before blur softens it),
 * and the panel's tint on top. That is lighter than anything the screen actually shows, so a
 * pass here holds everywhere. Solid mode is checked on the theme's solid colour.
 *
 * ── What is checked ──────────────────────────────────────────────────────────
 *
 *   1. #000 action ink on every gradient stop (a1, a2, a3)            ≥ 4.5
 *   2. t1, t2, t3 on glass (worst case) and on solid                  ≥ 4.5
 *   3. Each state chip's text on its own wash over glass              ≥ 4.5
 *   4. Badge ink (#000) on the blocked red; links and orb labels      ≥ 4.5
 *   5. themes.ts gradient stops === tokens.css --a1..--a3             exact
 *   6. A positive control: a pair known to fail (t4 on glass) does fail, so a broken
 *      parser that returns black-on-white everywhere cannot report a clean run.
 *
 * Exit code is the verdict; the table is for a person.
 *
 * Usage: node scripts/test-contrast.mjs
 */
import { readFileSync } from 'node:fs';

const css = readFileSync('src/styles/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const themesTs = readFileSync('src/styles/themes.ts', 'utf8');

// ── Parse ─────────────────────────────────────────────────────────────────────
function blocks() {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim();
    const vars = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      const k = d.slice(0, i).trim();
      if (k.startsWith('--')) vars[k] = d.slice(i + 1).trim();
    }
    out.push({ sel, vars });
  }
  return out;
}
const all = blocks();
const rootBlock = all.find((b) => b.sel === ':root');
if (!rootBlock) fail('no plain :root block in tokens.css');
const THEMES = ['mint', 'ember', 'ocean', 'aurora', 'rose', 'graphite'];
const themeVars = (id) => {
  const b = all.find((x) => x.sel.split(',').map((s) => s.trim()).includes(`[data-palette='${id}']`));
  if (!b) fail(`no theme block for ${id}`);
  return { ...rootBlock.vars, ...b.vars };
};

// ── Colour maths ─────────────────────────────────────────────────────────────
function parseColour(v, vars, depth = 0) {
  v = v.trim();
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref) {
    if (depth > 8 || !(ref[1] in vars)) throw new Error(`unresolved ${v}`);
    return parseColour(vars[ref[1]], vars, depth + 1);
  }
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).concat(1);
  m = v.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255).concat(1);
  m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1];
  }
  m = v.match(/^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/);
  if (m) return [...oklchToSrgb(+m[1], +m[2], +m[3]), 1];
  m = v.match(/^color-mix\(in oklch,\s*(.+?)\s+(\d+)%,\s*(white|black)\)$/);
  if (m) return mixOklch(parseColour(m[1], vars, depth + 1), m[3] === 'white' ? [1, 1, 1, 1] : [0, 0, 0, 1], +m[2] / 100);
  throw new Error(`cannot parse colour ${v}`);
}
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function oklchToSrgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((x) => Math.min(1, Math.max(0, gam(x))));
}
function srgbToOklch([r, g, b]) {
  const [R, G, B] = [r, g, b].map(lin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360];
}
/** CSS color-mix(in oklch, A p%, B): an achromatic side takes the other's hue (powerless hue). */
function mixOklch(A, B, p) {
  const a = srgbToOklch(A), b = srgbToOklch(B);
  const ha = a[1] < 1e-4 ? b[2] : a[2], hb = b[1] < 1e-4 ? a[2] : b[2];
  let dh = hb - ha;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return [...oklchToSrgb(a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), (ha + dh * (1 - p) + 360) % 360), 1];
}
/** Source-over: `top` (with alpha) on an opaque `under`. */
const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (fg, bg) => {
  const f = over(fg, bg);
  const [hi, lo] = [lum(f), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** The lighter end of a CSS linear-gradient of rgba stops — the worst case for light text. */
function tintTop(v, vars) {
  const stops = [...v.matchAll(/rgba\([^)]+\)/g)].map((x) => parseColour(x[0], vars));
  return stops.sort((x, y) => y[3] - x[3])[0] ?? [0, 0, 0, 0];
}

// ── Checks ───────────────────────────────────────────────────────────────────
const rows = [];
let failures = 0;
const AA = 4.5;
function check(theme, what, r, min = AA) {
  const ok = r >= min;
  if (!ok) failures++;
  rows.push({ theme, what, r, ok });
}
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const BLACK = [0, 0, 0, 1];
for (const id of THEMES) {
  const v = themeVars(id);
  const col = (k) => parseColour(v[k], v);
  const base = col('--base');

  // 1. ink on the gradient
  const ink = col('--act-ink');
  for (const k of ['--a1', '--a2', '--a3']) check(id, `ink on ${k} ${v[k]}`, ratio(ink, col(k)));
  check(id, `ink on --act-solid ${v['--act-solid']}`, ratio(ink, col('--act-solid')));

  // 2. text on glass, worst case: base + brightest orb at peak, glass, tint
  const glows = ['--g1', '--g2', '--g3'].map(col);
  const brightest = glows.map((g) => over(g, base)).sort((x, y) => lum(y) - lum(x))[0];
  const glassBg = over(tintTop(v['--tint'], v), over(col('--glass'), brightest));
  const solidBg = col('--solid');
  for (const k of ['--t1', '--t2', '--t3']) {
    check(id, `${k} on glass (glow peak)`, ratio(col(k), glassBg));
    check(id, `${k} on solid`, ratio(col(k), solidBg));
  }

  // 3. state chip text on its own wash (16% of the state over a 20% black, over glass)
  for (const s of ['draft', 'gen', 'rev', 'blk', 'rdy', 'live']) {
    const c = col(`--s-${s}`);
    const text = col(`--s-${s}-text`);
    const wash = over([...c.slice(0, 3), 0.16], over([0, 0, 0, 0.2], glassBg));
    check(id, `--s-${s}-text chip text`, ratio(text, wash));
    // The same text on the panel itself (a state word outside a chip: "Blocked", a cost in red).
    check(id, `--s-${s}-text on glass`, ratio(text, glassBg));
  }

  // Links and the orb-card labels: coloured text straight on glass.
  check(id, `--link on glass`, ratio(col('--link'), glassBg));
  for (const k of ['--orb-warm-text', '--orb-alert-text', '--orb-calm-text']) check(id, `${k} on glass`, ratio(col(k), glassBg));

  // 4. badge ink on the blocked red
  check(id, 'badge ink on --s-blk', ratio(BLACK, col('--s-blk')));

  // 5. the picker's labels are the stylesheet's stops
  const tsStops = themesTs.match(new RegExp(`id: '${id}'[\\s\\S]*?stops: \\[([^\\]]+)\\]`))?.[1];
  const want = ['--a1', '--a2', '--a3'].map((k) => v[k].toUpperCase());
  const got = (tsStops ?? '').match(/#[0-9A-Fa-f]{6}/g)?.map((x) => x.toUpperCase()) ?? [];
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures++;
    rows.push({ theme: id, what: `themes.ts stops ${got.join(' ')} ≠ tokens.css ${want.join(' ')}`, r: 0, ok: false });
  }
}

// 6. positive control: t4 is decoration-only and must NOT reach AA on glass.
{
  const v = themeVars('mint');
  const col = (k) => parseColour(v[k], v);
  const bg = over(col('--glass'), col('--base'));
  const r = ratio(col('--t4'), bg);
  if (r >= AA) fail(`positive control: t4 on glass measured ${r.toFixed(2)} — the parser is not reading the real colours`);
}

console.log('\nKiln Glass contrast (WCAG AA 4.5:1)\n');
for (const t of THEMES) {
  const mine = rows.filter((r) => r.theme === t);
  const bad = mine.filter((r) => !r.ok);
  const min = Math.min(...mine.filter((r) => r.r > 0).map((r) => r.r));
  console.log(`  ${bad.length ? '✗' : '✓'} ${t.padEnd(9)} ${mine.length} checks, lowest ${min.toFixed(2)}`);
  for (const r of bad) console.log(`      ✗ ${r.what}: ${r.r.toFixed(2)}`);
}
console.log(`\n  positive control: t4 on glass fails AA, as it must\n`);
if (failures) {
  console.error(`${failures} contrast failure(s).`);
  process.exit(1);
}
console.log('OK: every theme passes.');
