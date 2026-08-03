#!/usr/bin/env node
/**
 * Fail when a component sets a font size that `--ui-scale` cannot move.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this is really guarding
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The UI-scale preference works by multiplying `--ui-scale` into the size and space tokens.
 * A component that writes `text-[11.5px]` bypasses every one of them, so the preference
 * moves everything around that text and not the text — which looks like a broken control
 * rather than like a component opting out.
 *
 * When this was written the codebase had 363 such literals across twelve distinct values
 * between 9.5px and 19px. That is not a scale; it is twelve independent decisions, and it
 * is why adding a scale preference on its own would have shipped a slider that visibly did
 * nothing. The values were collapsed onto seven steps — see `--type-*` in tokens.css — and
 * this check is what stops the thirteenth from appearing.
 *
 * ── Why px specifically, and not rem ──────────────────────────────────────────
 *
 * A `text-[0.75rem]` literal is scalable by the browser's font-size setting but still not
 * by `--ui-scale`, so it is flagged too. The fix in both cases is the same: use the step.
 *
 * Arbitrary px for *non-size* properties — a 2px playhead marker, a 1px rule — is fine and
 * not flagged. Those are hairlines, and a hairline that scales is just a thicker hairline.
 *
 * Usage: node scripts/check-scalable-sizes.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src/app', 'src/components'];

/**
 * Font-size literals only.
 *
 * `text-[...]` in Tailwind is font-size when the value is a length, and colour when it is a
 * colour — `text-[#fff]` is a different utility wearing the same prefix. Matching on a
 * leading digit keeps this to sizes.
 */
const FONT_SIZE_LITERAL = /\btext-\[[0-9.]+(?:px|rem|em)\]/g;

/**
 * Fixed heights on things that hold text.
 *
 * WCAG 1.4.12 requires text to survive a 1.5× line-height override, and a row pinned to
 * `h-[62px]` clips instead. Flagged as a warning rather than an error because a fixed
 * height is legitimate on things that hold no text.
 */
const FIXED_HEIGHT = /\bh-\[[0-9.]+px\]/g;

const errors = [];
const warnings = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8');

    for (const hit of text.match(FONT_SIZE_LITERAL) ?? []) {
      errors.push({ file, hit });
    }
    for (const hit of text.match(FIXED_HEIGHT) ?? []) {
      warnings.push({ file, hit });
    }
  }
}

console.log('\nScalable sizes\n');

if (warnings.length > 0) {
  console.log(`  ${warnings.length} fixed pixel height(s) — check these survive 1.4.12 text spacing:`);
  for (const w of dedupe(warnings)) console.log(`    ${w.file}  ${w.hit}`);
  console.log('');
}

if (errors.length > 0) {
  console.error(`${errors.length} font size(s) that --ui-scale cannot move:\n`);
  for (const e of dedupe(errors)) console.error(`  ✗ ${e.file}  ${e.hit}`);
  console.error(
    '\n  Use a step instead: text-3xs text-2xs text-xs text-sm text-md text-lg text-xl.',
    '\n  They are clamp()ed between two viewport poles and multiplied by --ui-scale, so a',
    '\n  component never has to know either exists.\n',
  );
  process.exit(1);
}

console.log(`  No unscalable font sizes. ${warnings.length} fixed height(s) noted above.\n`);

function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => {
    const k = `${x.file}|${x.hit}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.tsx?$/.test(entry)) yield path;
  }
}
