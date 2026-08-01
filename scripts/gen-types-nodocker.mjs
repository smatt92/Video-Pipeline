#!/usr/bin/env node
/**
 * Generate src/lib/db/types.ts without Docker.
 *
 * `supabase gen types typescript` shells out to a postgres-meta container even when you
 * pass --db-url. In environments where container images cannot be pulled (locked-down
 * CI, restricted egress), that command is unusable and there is no flag to avoid it.
 *
 * This script calls the *same* generator the CLI calls — @supabase/postgres-meta, pinned
 * to the exact version the bundled CLI uses — directly against a Postgres connection.
 * The output is the CLI's output; only the transport differs. Types are still generated,
 * never hand-written (CLAUDE.md conventions).
 *
 * `pnpm db:types` remains the canonical command. Reach for this one only when Docker is
 * genuinely unavailable, and re-run the canonical command when it isn't — if the two
 * ever disagree, the CLI wins and this script needs its pin bumped.
 *
 * Usage: node scripts/gen-types-nodocker.mjs <db-url> [schema]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const dbUrl = process.argv[2];
const schema = process.argv[3] ?? 'public';
const out = 'src/lib/db/types.ts';

if (!dbUrl) {
  console.error('usage: node scripts/gen-types-nodocker.mjs <db-url> [schema]');
  process.exit(1);
}

const pkgRoot = dirname(require.resolve('@supabase/postgres-meta/package.json'));
const { version: pgMetaVersion } = require('@supabase/postgres-meta/package.json');

const { default: PostgresMeta } = await import(`${pkgRoot}/dist/lib/PostgresMeta.js`);
const { getGeneratorMetadata } = await import(`${pkgRoot}/dist/lib/generators.js`);
const { apply } = await import(`${pkgRoot}/dist/server/templates/typescript.js`);

const pgMeta = new PostgresMeta({ connectionString: dbUrl, max: 1 });

const { data, error } = await getGeneratorMetadata(pgMeta, { includedSchemas: [schema] });
if (error) {
  console.error(`postgres-meta failed: ${error.message ?? JSON.stringify(error)}`);
  process.exit(1);
}

// detectOneToOneRelationships matches the CLI's default for `gen types typescript`.
const types = await apply({ ...data, detectOneToOneRelationships: true });

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, types);
await pgMeta.end();

console.error(
  `wrote ${out} (schema="${schema}", @supabase/postgres-meta@${pgMetaVersion}, no-docker path)`,
);
