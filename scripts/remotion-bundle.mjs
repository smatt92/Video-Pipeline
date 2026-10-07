#!/usr/bin/env node
/**
 * pnpm remotion:bundle — build the Remotion site ONCE, before the worker deploys.
 *
 * The worker used to call `@remotion/bundler` at render time. Trigger's build bundles the
 * task code with esbuild, and esbuild-bundling the bundler (rspack + webpack internals) breaks
 * it at runtime: S001's first render on 07-Oct failed with "Assignment to constant variable."
 * after voice had been paid for. Reproduced locally by esbuild-bundling bundleRemotion() —
 * it throws inside @rspack/binding; marked external it works.
 *
 * So the site is built here, in CI, where the bundler runs as plain node, and shipped into the
 * image with `additionalFiles` (trigger.config.ts). At render time the worker only SERVES it —
 * `layer-render.ts` prefers `remotion-bundle/` when present. Locally and in harnesses, with no
 * prebuilt site, it still bundles on the fly.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const { bundle } = await import('@remotion/bundler');
const outDir = join(process.cwd(), 'remotion-bundle');
rmSync(outDir, { recursive: true, force: true });
const serveUrl = await bundle({ entryPoint: join(process.cwd(), 'src/remotion/index.ts'), outDir });
console.log(`Remotion site built at ${serveUrl}`);
