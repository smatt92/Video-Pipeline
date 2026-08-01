#!/usr/bin/env node
/**
 * Fail the build if any variable other than the two permitted ones carries a
 * NEXT_PUBLIC_ prefix.
 *
 * Next inlines every NEXT_PUBLIC_ variable into the client bundle at build time. That
 * makes the prefix a *publication decision*, not a naming convention — and it is a
 * one-way one, because the value ships to every visitor and is in their cache before
 * anyone notices. A single typo (`NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY`) publishes a
 * credential that bypasses every access control in the database.
 *
 * Runs as `prebuild`, so it fires on `pnpm build` — locally, in CI, and on Vercel, where
 * it sees the real deployment environment.
 *
 * Two sources are checked, because they fail differently:
 *   - process.env catches what the deployment is actually about to inline.
 *   - .env.example and .env.local catch it at review time, before anyone deploys.
 */

import { existsSync, readFileSync } from 'node:fs';

const ALLOWED = new Set(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY']);

/** Variables Next.js and Vercel set themselves. Not ours, and not a leak. */
const IGNORED_PREFIXES = ['NEXT_PUBLIC_VERCEL_'];

const violations = [];

function check(name, source) {
  if (!name.startsWith('NEXT_PUBLIC_')) return;
  if (ALLOWED.has(name)) return;
  if (IGNORED_PREFIXES.some((p) => name.startsWith(p))) return;
  violations.push({ name, source });
}

for (const name of Object.keys(process.env)) {
  check(name, 'process.env');
}

for (const file of ['.env.example', '.env.local', '.env']) {
  if (!existsSync(file)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) check(m[1], `${file}:${i + 1}`);
  }
}

if (violations.length) {
  console.error('NEXT_PUBLIC_ check failed.\n');
  for (const v of violations) {
    console.error(`  ${v.name}   (${v.source})`);
  }
  console.error(
    [
      '',
      'Only these may carry the prefix:',
      ...[...ALLOWED].map((a) => `  ${a}`),
      '',
      'Anything else prefixed NEXT_PUBLIC_ is inlined into the client bundle and shipped',
      'to every visitor. If the value above is genuinely public, add it to ALLOWED in this',
      'script and say why. If it is not, rename it — and if it was ever deployed, rotate it.',
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `NEXT_PUBLIC_ check passed — only ${[...ALLOWED].join(' and ')} are client-published.`,
);
