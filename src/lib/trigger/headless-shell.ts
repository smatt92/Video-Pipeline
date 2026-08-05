import type { BuildExtension } from '@trigger.dev/build/extensions';

/**
 * Put `chrome-headless-shell` on the worker image, and point Remotion at it.
 *
 * ── Why not `puppeteer()` ────────────────────────────────────────────────────
 *
 * Because it installs the wrong browser, and the failure lands after money has moved.
 *
 * Reading that extension's source rather than trusting its name: it runs
 * `apt-get install google-chrome-stable` and sets `PUPPETEER_EXECUTABLE_PATH`. Chrome-stable
 * supports only the *new* headless mode. Remotion drives the old one and refuses with
 * "Old Headless mode has been removed from the Chrome binary". So the image would grow, the
 * deploy would succeed, and the first render would fail — on a worker, after the clips being
 * assembled had been generated and paid for.
 *
 * `chrome-headless-shell` is the standalone implementation of exactly that mode. No shipped
 * Trigger extension installs it, which is why this exists.
 *
 * ── One binary, resolved one way, in three places ────────────────────────────
 *
 * The dev container has it under `PLAYWRIGHT_BROWSERS_PATH`; CI installs it with
 * `@puppeteer/browsers` and exports `REMOTION_BROWSER_EXECUTABLE`; this puts it on the worker
 * and exports the same variable. `renderComposition` takes the path as a parameter and never
 * reads the environment itself, so the three environments differ in one line of resolution
 * rather than in three mechanisms.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 *
 * **Unverified.** No deploy has run. `check:trigger-build` cannot help here either — it
 * derives image requirements from binaries `src/` spawns, and this one is spawned from inside
 * `node_modules` by Remotion, which that check states plainly it cannot see. The evidence for
 * the version pin and the install path is the same install `verify:render` uses in CI, which
 * is green; the evidence that it works in *this* image is a deploy nobody has done.
 */

/** Pinned. `@stable` would silently move the browser under a renderer that expects one. */
const SHELL_VERSION = '145.0.7332.0';

export function headlessShell(): BuildExtension {
  return {
    name: 'chrome-headless-shell',
    onBuildComplete(context) {
      // Dev runs against the developer's own machine, which already has a browser resolved
      // by `verify:render`'s search. Installing one here would slow every dev boot for a
      // path that is not used.
      if (context.target === 'dev') return;

      context.addLayer({
        id: 'chrome-headless-shell',
        image: {
          instructions: [
            // The shell is a Chromium build and needs the same shared libraries Chrome does;
            // installing it without them produces a binary that exits with a linker error
            // rather than anything naming a browser.
            'RUN apt-get update && apt-get install -y --no-install-recommends '
              + 'ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 '
              + 'libcups2 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 libpango-1.0-0 '
              + 'libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 '
              + 'libxrandr2 xdg-utils '
              + '&& apt-get clean && rm -rf /var/lib/apt/lists/*',
            `RUN npx --yes @puppeteer/browsers install chrome-headless-shell@${SHELL_VERSION} `
              + '--path /opt/browsers',
          ],
        },
        deploy: {
          env: {
            // Consumed by whatever passes `browserExecutable` into `renderComposition`.
            // Deliberately NOT yet in `src/lib/trigger/worker-env.ts`: nothing reads it until
            // the assemble task does, and `check:trigger-env` derives requirements from the
            // import graph — a declared-but-unreachable entry is what that check exists to
            // catch.
            REMOTION_BROWSER_EXECUTABLE:
              `/opt/browsers/chrome-headless-shell/linux-${SHELL_VERSION}/`
              + 'chrome-headless-shell-linux64/chrome-headless-shell',
          },
          override: true,
        },
      });
    },
  };
}
