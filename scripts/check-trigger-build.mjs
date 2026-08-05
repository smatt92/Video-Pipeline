#!/usr/bin/env node
/**
 * Fail before a deploy if the worker image would not have ffmpeg.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The failure this replaces
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `05b-ingest` and `07-assemble` shell out to `ffmpeg` and `ffprobe`. Trigger's default
 * worker image carries neither, so without the build extension the first ingest fails with
 * `spawn ffmpeg ENOENT` — **after** the generation has been paid for. The money is gone,
 * the asset is on a vendor CDN that expires, and the error names a binary rather than the
 * config line that omitted it.
 *
 * That is a runtime surprise standing in for a build-time error, and this file is the swap.
 * It costs a second and runs in CI on every push.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves, and what only a deploy can
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROVES: `@trigger.dev/build` is installed at a version whose `extensions/core` entry
 *         exports `ffmpeg`; calling it produces an extension object with a name; and
 *         `trigger.config.ts` actually declares it. That covers the whole class of silent
 *         breakage — a renamed export, a moved subpath, a dependency dropped from
 *         package.json, or somebody deleting the line while tidying.
 *
 * DOES NOT: build an image. The extension's own correctness — that it installs a working
 *           ffmpeg into the container — is only observable by deploying. Run
 *           `pnpm trigger:deploy:dry` for that; it builds locally and uploads nothing.
 *
 * DOES NOT, and this is the sharper limit: **see a binary that a dependency spawns.** The
 *           derivation below reads `src/`, so it finds what our code launches and is blind
 *           to what a package launches on our behalf. `@remotion/renderer` is exactly that
 *           case — it drives a headless Chromium it brings itself, from inside node_modules,
 *           and no amount of grepping `src/` will ever mention it.
 *
 *           Stated rather than fixed, because the fix is not obvious and guessing at it is
 *           worse than naming the gap: whether the worker image needs a build extension for
 *           that Chromium, and which one, is a question a deploy answers and this file
 *           cannot. It is recorded in DECISIONS-PENDING 4 as the open half of adding that
 *           dependency. A check that quietly covered 90% of the binaries while reading as
 *           though it covered all of them is the failure this project keeps finding.
 *
 * Usage: node scripts/check-trigger-build.mjs
 */

import { readFileSync } from 'node:fs';

const problems = [];
const notes = [];

// ── 1. Which code actually shells out to a binary the image must carry ──────
//
// Derived rather than hardcoded. A list of "tasks that need ffmpeg" is a list somebody has
// to remember to update, which is the same failure mode one level up.
const BINARIES = ['ffmpeg', 'ffprobe'];
const sources = await collectSources('src');
const needs = new Map();

for (const [file, text] of sources) {
  // Only files that can start a process. Without this, a comment or an error message
  // mentioning ffmpeg would register as a dependency.
  if (!/from\s+['"]node:child_process['"]/.test(text)) continue;

  for (const binary of BINARIES) {
    // The binary as the first argument of *any* call, not only of `execFile` by name.
    //
    // The first version of this matched `execFile('ffmpeg', …)` literally, and both files
    // that spawn ffmpeg in this repo do `const run = promisify(execFile)` and then
    // `run('ffprobe', …)`. So it found nothing, printed "no binary dependencies found",
    // and passed — a green check that proved the opposite of what it claimed, which is
    // exactly the class of failure this file exists to prevent, one level up.
    if (new RegExp(`\\(\\s*['"\`]${binary}['"\`]\\s*[,)]`).test(text)) {
      if (!needs.has(binary)) needs.set(binary, []);
      needs.get(binary).push(file);
    }
  }
}

// ── 2. Does the package still export the extension? ─────────────────────────
let extensionName = null;
if (needs.size > 0) {
  try {
    const mod = await import('@trigger.dev/build/extensions/core');
    if (typeof mod.ffmpeg !== 'function') {
      problems.push(
        '`@trigger.dev/build/extensions/core` no longer exports `ffmpeg` as a function. ' +
          'The package moved or renamed it, and trigger.config.ts is importing something ' +
          'that will fail at build time — or worse, resolve to undefined.',
      );
    } else {
      const extension = mod.ffmpeg();
      extensionName = extension?.name ?? null;
      if (!extensionName) {
        problems.push(
          'Calling `ffmpeg()` produced an object with no `name`. Trigger identifies build ' +
            'extensions by name; a nameless one is silently ignored, which is the exact ' +
            'shape of failure this check exists to prevent.',
        );
      }
    }
  } catch (err) {
    problems.push(
      `\`@trigger.dev/build/extensions/core\` could not be imported: ${err.message}\n` +
        '    `@trigger.dev/build` is a devDependency. If it is missing here it is missing ' +
        'from the deploy too, and the worker image ships without ffmpeg.',
    );
  }
}

// ── 3. Does the config declare it? ──────────────────────────────────────────
//
// Read as text rather than imported: `trigger.config.ts` is TypeScript and reads
// `process.env.TRIGGER_PROJECT_REF!` at module scope, so importing it needs a compile step
// and an environment. The question here is only whether the declaration is present, and the
// import above already proved the thing being declared exists.
const config = readFileSync('trigger.config.ts', 'utf8');
const declaresImport = /from\s+['"]@trigger\.dev\/build\/extensions\/core['"]/.test(config);
const declaresExtension = /extensions\s*:\s*\[[^\]]*\bffmpeg\s*\(/s.test(config);

if (needs.size > 0) {
  if (!declaresImport) {
    problems.push(
      'trigger.config.ts does not import from `@trigger.dev/build/extensions/core`, but ' +
        `${[...needs.keys()].join(' and ')} are spawned by code that runs on the worker.`,
    );
  }
  if (!declaresExtension) {
    problems.push(
      'trigger.config.ts has no `ffmpeg()` in its `build.extensions` array. The worker ' +
        'image will not carry ffmpeg, and the first ingest will fail with `spawn ffmpeg ' +
        'ENOENT` after a generation has been paid for.',
    );
  }
}

// ── 4. The inverse: an extension nothing needs ──────────────────────────────
//
// Not an error, but worth saying. An extension declared for code that no longer exists is
// image weight and build time nobody chose, and it is the kind of thing that survives a
// refactor unnoticed.
if (needs.size === 0 && declaresExtension) {
  notes.push(
    'trigger.config.ts declares the ffmpeg extension and nothing under src/ spawns ffmpeg ' +
      'or ffprobe any more. Not a failure — but the image is carrying it for nobody.',
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

console.log('\nTrigger worker image — pre-deploy check\n');

if (needs.size === 0) {
  console.log('  no binary dependencies found under src/');
} else {
  for (const [binary, files] of needs) {
    console.log(`  ${binary}  needed by ${files.length} file(s)`);
    for (const f of files) console.log(`      ${f}`);
  }
  console.log('');
  console.log(`  extension  ${extensionName ?? '(not resolved)'}`);
  console.log(`  declared   ${declaresExtension ? 'yes' : 'NO'}`);
}

for (const note of notes) console.log(`\n  note: ${note}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) that would ship a broken worker image:\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  '\nThe worker image declares every binary src/ spawns.\n' +
    'This does not prove the extension installs a working ffmpeg — only a build can, and\n' +
    '`pnpm trigger:deploy:dry` is that build without an upload.\n',
);

/** Every .ts/.tsx file under a directory, as [path, contents]. */
async function collectSources(root) {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const out = [];

  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) out.push([path, readFileSync(path, 'utf8')]);
    }
  }

  await walk(root);
  return out;
}
