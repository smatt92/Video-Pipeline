/**
 * Read the integration catalogue out of `src/lib/drivers/catalog.ts`.
 *
 * Source text rather than a compiled import, so anything using it runs with no TypeScript
 * toolchain and before a build — the same reason `check-enums.mjs` parses `enums.ts`.
 *
 * A regex over TypeScript is a liability when it silently matches nothing. Every function
 * here asserts a non-trivial result, because a check that quietly stops checking is worse
 * than no check: it reports PASS forever.
 */

import { readFileSync } from 'node:fs';

export const CATALOG_PATH = 'src/lib/drivers/catalog.ts';

function catalogBody() {
  const src = readFileSync(CATALOG_PATH, 'utf8');
  const start = src.indexOf('INTEGRATION_CATALOG');
  if (start === -1) throw new Error(`INTEGRATION_CATALOG not found in ${CATALOG_PATH}`);
  return src.slice(start);
}

/** `[{ slug, kind }]`, in catalogue order. */
export function catalogEntries() {
  const body = catalogBody();
  const entries = [];
  const re = /slug:\s*'([^']+)',\s*\n\s*label:[^\n]*\n\s*kind:\s*'([^']+)'/g;

  let m;
  while ((m = re.exec(body)) !== null) {
    entries.push({ slug: m[1], kind: m[2], at: m.index });
  }

  if (entries.length < 2) {
    throw new Error(
      `Parsed ${entries.length} integrations out of ${CATALOG_PATH}, which cannot be right. ` +
        'The descriptor shape changed and this parser stopped parsing. Fix it before ' +
        'trusting anything built on it.',
    );
  }

  return entries;
}

/**
 * `[{ driver, model, endpoint, unit }]` — every priced call the catalogue declares.
 *
 * Sliced per descriptor so a rate is attributed to the integration that declares it. The
 * `rates:` array is the last field of each descriptor, so "from this slug to the next" is
 * a safe window.
 */
export function catalogRates() {
  const body = catalogBody();
  const entries = catalogEntries();
  const rates = [];

  entries.forEach((entry, i) => {
    const end = i + 1 < entries.length ? entries[i + 1].at : body.length;
    const block = body.slice(entry.at, end);
    const re =
      /\{\s*model:\s*'([^']+)',\s*endpoint:\s*(null|'[^']*'),\s*unit:\s*'([^']+)'\s*\}/g;

    let m;
    while ((m = re.exec(block)) !== null) {
      rates.push({
        driver: entry.slug,
        model: m[1],
        endpoint: m[2] === 'null' ? null : m[2].slice(1, -1),
        unit: m[3],
      });
    }
  });

  if (rates.length === 0) {
    throw new Error(
      `Parsed no rates out of ${CATALOG_PATH}. The catalogue declares priced calls, so ` +
        'zero means the parser is broken, not that there is nothing to check.',
    );
  }

  return rates;
}

/**
 * Drivers that get a `driver_health` row.
 *
 * The video ones, and derived rather than listed so it tracks the catalogue. Migration
 * 0014 makes the same argument: the breaker guards submits that spend credits against an
 * unreliable vendor, and the LLM and storage paths fail loudly and immediately.
 */
export function breakerDrivers() {
  return catalogEntries()
    .filter((e) => e.kind === 'video')
    .map((e) => e.slug);
}
