#!/usr/bin/env node
/**
 * Fail when the Remotion packages are not all on the same version.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The failure this replaces
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Remotion ships as several packages that must be on the **identical** version — not
 * merely compatible ranges. `remotion` and `@remotion/player` were on 4.0.504; adding
 * `@remotion/renderer` with no version pulled 4.0.506, because that is what `latest`
 * resolved to that minute. Two of three packages agreed and one did not.
 *
 * Nothing local would have caught it. It typechecks, it builds, `pnpm check` is green, and
 * the mismatch surfaces at the moment a render is attempted — which in this project is
 * inside a Trigger task, on a worker, after the clips it is assembling have been generated
 * and paid for. That is the same shape as the missing ffmpeg binary next door, and it is
 * why that check exists rather than a note in a README.
 *
 * It is also a drift a caret range invites: `^4.0.504` on two packages and a fresh install
 * of the third is enough, and so is one `pnpm up` that happens to touch one of them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves, and what only a render can
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROVES: every installed package whose name is `remotion` or begins `@remotion/` reports
 *         the same version. Derived from what is on disk, not from the ranges in
 *         package.json — the range is the intent and the installed tree is the fact, and
 *         a lockfile can satisfy the ranges while disagreeing with itself.
 *
 * DOES NOT: render anything. Whether that version actually produces a correct MP4 is
 *           Gate-shaped and needs a real render, which needs a worker.
 *
 * Usage: node scripts/check-remotion-lockstep.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const found = new Map();

// Read package.json for `remotion` and every `@remotion/*` that is actually installed.
// Walking node_modules rather than reading our own dependency list on purpose: a
// transitive copy at a different version is exactly as fatal as a direct one, and would
// be invisible to a check that only read what we declared.
function version(dir) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const root = 'node_modules';
const bare = version(join(root, 'remotion'));
if (bare) found.set('remotion', bare);

const scope = join(root, '@remotion');
if (existsSync(scope)) {
  for (const name of readdirSync(scope)) {
    const v = version(join(scope, name));
    if (v) found.set(`@remotion/${name}`, v);
  }
}

console.log('\nRemotion packages — version lockstep\n');

if (found.size === 0) {
  // Not a failure. Remotion is a real dependency of stage 7 and this check is about the
  // relationship between its packages, so "none installed" is a state with nothing to
  // check rather than a broken one — and saying so beats a silent pass.
  console.log('  none installed — nothing to check\n');
  process.exit(0);
}

for (const [name, v] of [...found].sort()) console.log(`  ${name.padEnd(24)} ${v}`);

const versions = new Set(found.values());

if (versions.size > 1) {
  console.error(
    `\n${versions.size} different versions across ${found.size} Remotion packages.\n`,
  );
  console.error(
    '  ✗ Remotion requires every one of its packages to be on the identical version, not\n' +
      '    merely on compatible ranges. A mismatch typechecks, builds, and passes every\n' +
      '    check in this repo — then fails at the moment a render is attempted, which here\n' +
      '    is on a worker, after the clips being assembled have been generated and paid for.\n\n' +
      `    Pin them all to one version:  pnpm add ${[...found.keys()].join('@<version> ')}@<version>\n`,
  );
  process.exit(1);
}

console.log(
  `\nAll ${found.size} on ${[...versions][0]}.\n` +
    'This does not prove that version renders correctly — only a real render can.\n',
);
