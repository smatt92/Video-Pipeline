/**
 * Find a Chromium to drive, wherever this is running.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this is not a constant
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `verify-scaling.mjs` hard-coded `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`,
 * which is the path in the development container and exists on no GitHub runner. It is
 * wired into CI. That is the same shape as every other defect in 0008 §0 and §0a — a check
 * that looks wired and cannot execute — one layer down, and it would have surfaced as a
 * confusing ENOENT rather than as a message about a missing browser.
 *
 * Worse, the pinned version number means the path rots inside the container too: bumping
 * Playwright moves `chromium-1194` to `chromium-1207` and the check starts failing for a
 * reason that has nothing to do with what it checks.
 *
 * So: a search, most-specific first, with the version glob resolved rather than typed.
 *
 * ── It refuses rather than skipping ─────────────────────────────────────────
 *
 * No browser means exit 2 and a message naming what was looked for. It deliberately does
 * not skip: a harness that quietly passes when it cannot run is exactly the failure this
 * project has now found three times, and "the browser was missing" reads identically to
 * "the browser found nothing wrong" in a CI log nobody opens.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The Playwright store, whose directory name carries a version that must not be typed. */
function playwrightChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((d) => d.startsWith('chromium'))
      // Newest first, so a container with two installed uses the current one.
      .sort()
      .reverse()
      .map((d) => join(root, d, 'chrome-linux', 'chrome'));
  } catch {
    return [];
  }
}

export function findChrome() {
  const candidates = [
    // An explicit override always wins. This is the escape hatch for a machine whose
    // browser is somewhere none of the guesses below would look.
    process.env.CHROME_PATH,
    // The dev container, and the path a `playwright install` writes to.
    ...playwrightChromium(),
    join(process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers', 'chromium'),
    // GitHub's ubuntu images ship all of these.
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    // macOS, for someone running the harness by hand.
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  const found = candidates.find((p) => existsSync(p));
  if (found) return found;

  console.error(
    '\nNo Chromium to drive. This harness measures a real browser, so there is nothing\n' +
      'it can honestly report without one — it refuses rather than passing.\n\n' +
      'Looked for:\n' +
      candidates.map((p) => `  ${p}`).join('\n') +
      '\n\nSet CHROME_PATH to a Chromium or Chrome binary, or install one.\n',
  );
  process.exit(2);
}
