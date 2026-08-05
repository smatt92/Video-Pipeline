#!/usr/bin/env node
/**
 * Fail when a package script shares a name with a pnpm builtin, because pnpm wins silently.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The failure this replaces
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `doctor` is a pnpm builtin. `pnpm doctor` therefore ran pnpm's diagnostic, not Kiln's —
 * with **no output and exit 0** — for as long as that script existed. Every "run
 * `pnpm doctor`" in this repo's error hints, README and handovers named a command that
 * diagnosed nothing about this project, and every claim of having run it was a claim about
 * nothing.
 *
 * The tell is worth keeping: **zero output with a zero exit.** A real run says something.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this probes, and why it probes somewhere else
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A hardcoded list of pnpm's commands would be right today and wrong the release pnpm adds
 * one — wrong in the direction that matters, because a new builtin silently captures an
 * existing script rather than erroring.
 *
 * Parsing `pnpm help` does not work either, and finding out why is the point: **`doctor` is
 * absent from that listing.** `pnpm doctor --help` prints "Usage: pnpm doctor — Checks for
 * known common issues" and links pnpm's docs, so it is unambiguously a command; the summary
 * help just does not mention it. A parser built on that output would have missed the exact
 * defect this file exists for.
 *
 * So it asks pnpm directly — **from an empty directory**. That is the whole trick. In this
 * repo, `pnpm build --help` finds a script named `build` and *runs* it, which is both a
 * wrong answer and a side effect. With no package.json in scope there is no script to
 * resolve, so a "Usage: pnpm <name>" banner can only mean a builtin, and nothing executes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * What this proves, and what it does not
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * PROVES: no script in package.json is shadowed by the pnpm on this machine, established by
 *         asking that pnpm rather than by consulting a list somebody wrote.
 *
 * DOES NOT: protect a name a *future* pnpm claims. Nothing can, from inside the repo — which
 *           is why the convention matters more than the check: **a colon makes a name
 *           uncollidable**, since no pnpm command contains one. `db:doctor` is safe by
 *           construction in a way `doctor` never was.
 *
 * The namespace it moved into was a second decision, and `check:` was the wrong one. A
 * `check:` name is a guard, and `check:gates` would then have demanded it gate a push —
 * which doctor cannot, because it exits 2 for "this could not be checked", a useful answer
 * to a person and a broken build to CI. It is a diagnostic that names which failure you
 * have, not a gate. `db:` says that, and `db:push`/`db:bundle` were already there.
 *
 * Usage: node scripts/check-script-names.mjs
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const scripts = Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {});

// A colon cannot appear in a pnpm command, so these are safe by construction and not worth
// a subprocess each. Stated rather than assumed: it is the whole reason the convention works.
const collidable = scripts.filter((name) => !name.includes(':'));

console.log('\nScript names — pnpm builtin collisions\n');
console.log(`  ${scripts.length} scripts, ${collidable.length} without a colon and therefore checkable\n`);

// Probed from an empty directory so no package script can be resolved and nothing runs.
const probeDir = await mkdtemp(join(tmpdir(), 'kiln-pnpm-probe-'));

/** True when pnpm answers with its own usage banner, which only a builtin produces. */
async function isBuiltin(name) {
  try {
    const { stdout } = await run('pnpm', [name, '--help'], { cwd: probeDir, timeout: 20_000 });
    return new RegExp(`^Usage:\\s+pnpm ${name}\\b`, 'm').test(stdout);
  } catch {
    return false;
  }
}

// POSITIVE CONTROL, and it is load-bearing. A probe that silently stops working — pnpm
// changing its help format, the binary missing from PATH — would report "no collisions" for
// every name and read exactly like a pass. An absence result is only evidence when the
// instrument is known to be able to see the thing.
const controlHit = await isBuiltin('install');
const controlMiss = await isBuiltin('kiln-not-a-pnpm-command');

if (!controlHit || controlMiss) {
  console.error(
    '\nThe probe is not working, so its answer means nothing.\n\n' +
      `  "install" detected as a builtin: ${controlHit} (expected true)\n` +
      `  a nonsense name detected as one:  ${controlMiss} (expected false)\n\n` +
      "pnpm's help format probably changed. Fix the probe before trusting a clean run.\n",
  );
  await rm(probeDir, { recursive: true, force: true });
  process.exit(1);
}

console.log('  probe verified: "install" is a builtin, a nonsense name is not\n');

const shadowed = [];

for (const name of collidable) {
  if (await isBuiltin(name)) {
    shadowed.push({ name });
  }
}

await rm(probeDir, { recursive: true, force: true });

if (shadowed.length > 0) {
  console.error(`${shadowed.length} script(s) shadowed by a pnpm builtin:\n`);
  for (const s of shadowed) {
    console.error(
      `  ✗ "${s.name}" — pnpm resolves its own command, so \`pnpm ${s.name}\` never runs this\n` +
        `    project's script. It exits 0 having done nothing, which reads as success.\n\n` +
        `    Rename it with a colon — \`check:${s.name}\` or similar. No pnpm builtin\n` +
        '    contains one, so a colon makes the name safe permanently.\n',
    );
  }
  process.exit(1);
}

console.log('  no collisions\n');
console.log(
  'This cannot protect a name a future pnpm claims. The colon convention can, and does.\n',
);
