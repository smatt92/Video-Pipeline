#!/usr/bin/env node
/**
 * check:duplicates — two things for one concept, caught on purpose this time.
 *
 * The two-modules rule has fired twice and neither catch was the rule working:
 *
 *   · `src/lib/generate/normalise.ts` and `src/lib/ingest/normalise.ts` both defined the
 *     canonical intermediate, disagreed about it, and only one was live. Found by reading.
 *   · A second `v_credit_position` was written into migration 0031 while the first had
 *     existed since 0008 with a reader. **It was caught because Postgres refused to create
 *     it** — a duplicate name is the one case the database happens to catch, and it caught
 *     it at apply time, in the middle of a two-round audit of exactly that pattern.
 *
 * Luck is not coverage. This is the guard.
 *
 * ── Three checks, and why they are split this way ────────────────────────────
 *
 *   1. Module basename collisions under `src/lib`. Static. Two files called `normalise.ts`
 *      in different directories is the literal case, and the next person to tune one has a
 *      coin-flip's chance of editing the copy that does nothing.
 *
 *   2. A view created twice in the migration sequence with no `drop view` between. Static,
 *      and deliberately not left to Postgres: the database does refuse it, but only when
 *      somebody applies migrations, only with "relation already exists", and only after the
 *      earlier migrations have been committed. Failing here says which two migrations and
 *      which view before any of that.
 *
 *   3. Column-set overlap between live views. Needs a database, because deriving a view's
 *      output columns from its SQL means parsing SQL, and a parser that is wrong in one
 *      direction produces false confidence. `information_schema` is exact.
 *      `v_shot_readiness` versus `v_unresolved_shots` is this shape — different names,
 *      near-identical columns, one with no reader — and it was found by hand.
 *
 * Overlap is not automatically wrong. `v_video_cost` and `v_cost_unattributed` are
 * deliberate complements. So an overlap fails until it is named in EXEMPTIONS with a
 * reason, and an exemption for a pair that no longer overlaps fails too — the same
 * arrangement `check:gates` uses, for the same reason: an exemption that outlives its cause
 * is a claim nobody re-examines.
 *
 * Usage: node scripts/check-duplicates.mjs [db-url]
 *        Without a url, checks 1 and 2 only, and says so.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/**
 * Pairs allowed to overlap, each with the reason. Keyed as "a::b", alphabetical.
 *
 * A reason here has to say why the two are *not* the same concept. "They are similar" is
 * not a reason; "one is the complement of the other and the pair is exhaustive" is.
 */
const EXEMPTIONS = {
  'v_render_cost::v_script_cost':
    'Different denominators over the same spend. v_script_cost is what one script cost with '
    + 'draft and generation kept separate; v_render_cost divides the script-level share '
    + 'across the final renders, so SUM over it is meaningful and SUM over the other is not. '
    + 'Deleting either loses a question the other cannot answer.',
  'v_replayed_callbacks::v_unconfirmed_terminal_generations':
    'Two different forgery signals over the same generations columns. One is "more than one '
    + 'delivery arrived", which is usually a harmless vendor retry; the other is "a terminal '
    + 'outcome was written without the vendor being asked", which should always be empty. '
    + 'Shared columns are the subject, not the meaning.',
};

/**
 * Module basenames allowed to repeat, each with the reason.
 *
 * A repeated basename is a signal rather than a defect — `normalise.ts` was one, and
 * `env.ts` appearing three times is a project rule being obeyed. So this fails until each
 * pair is named, which is the point: somebody has to look once.
 */
const MODULE_EXEMPTIONS = {
  'env.ts':
    'Three, and rule 1 requires it: drivers/env.ts holds vendor credentials because no '
    + 'vendor name may appear outside the driver layer, storage/env.ts the same for the '
    + 'bucket, and lib/env.ts is the app\u2019s own validated config. Merging them would put '
    + 'vendor names in core config, which check:vendors refuses.',
  'worker-env.ts':
    'Three, for the same reason env.ts is three, and composed the same way: '
    + 'trigger/worker-env.ts is the manifest and spreads in the other two, which exist '
    + 'because drivers/ and storage/ are the only directories permitted to name a vendor '
    + 'or a bucket. These are fragments of one list rather than three lists — the parser '
    + 'in scripts/lib/worker-env.mjs concatenates them and fails on a name declared twice, '
    + 'so they cannot drift into disagreeing about a variable.',
  'supabase.ts':
    'auth/supabase.ts is the browser/server auth client; storage/supabase.ts is the S3 '
    + 'storage driver. Same vendor, two capabilities, and rule 2 keeps the byte-moving one '
    + 'in the driver layer where only src/trigger/ imports it.',
  'draft.ts':
    'script/draft.ts drafts a script from a concept (stage 3); shots/draft.ts is the '
    + 'shotlist decode shape (stage 4). Different stages, different vocabularies, no shared '
    + 'export.',
  'enqueue.ts':
    'generate/enqueue.ts exports enqueueIngest only; studio/enqueue.ts exports '
    + 'enqueueAssemble and enqueueGenerate. Disjoint export sets — the file name is the verb, '
    + 'not the concept.',
  'materialise.ts':
    'assemble/materialise.ts turns a shot list into clip inputs for ffmpeg; '
    + 'studio/materialise.ts turns a Studio session into a script row. Two different things '
    + 'called materialising, which is a naming collision worth watching but not a duplicate '
    + 'implementation \u2014 no shared export, no shared caller.',
};

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;

let failures = 0;
const fail = (m) => { console.error(`  ✗ ${m}`); failures += 1; };
const pass = (m) => console.log(`  ✓ ${m}`);

console.log('\nTwo things for one concept\n');

// ── 1. Module basename collisions ───────────────────────────────────────────────
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
};

{
  const byBase = new Map();
  for (const f of walk('src/lib')) {
    const b = basename(f);
    // `index.ts` and `types.ts` are structural names, not concept names.
    if (['index.ts', 'types.ts', 'schema.ts', 'run.ts', 'actions.ts', 'read.ts', 'write.ts'].includes(b)) continue;
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }

  const collisions = [...byBase.entries()].filter(([, fs]) => fs.length > 1);
  const seen = new Set();
  for (const [b, fs] of collisions) {
    if (MODULE_EXEMPTIONS[b]) {
      seen.add(b);
      pass(`${b} \u00d7${fs.length} — allowed: ${MODULE_EXEMPTIONS[b].slice(0, 64)}\u2026`);
    } else {
      fail(
        `${b} exists in ${fs.length} places: ${fs.join(', ')}. Two modules for one concept is ` +
          `worse than none — delete one, or add the basename to MODULE_EXEMPTIONS with a ` +
          `reason saying why these are different concepts that happen to share a verb.`,
      );
    }
  }
  for (const b of Object.keys(MODULE_EXEMPTIONS)) {
    if (!seen.has(b)) {
      fail(`${b} is exempted and no longer collides. Remove the exemption.`);
    }
  }
  if (collisions.length === 0) {
    pass(`no module basename appears twice under src/lib (${byBase.size} distinct names)`);
  }
}

// ── 2. A view created twice with no drop between ────────────────────────────────
{
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  /** @type {Map<string, string>} view -> the migration that currently owns it */
  const live = new Map();
  let dupes = 0;

  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // Strip line comments so a `-- create view x` in prose is not read as a definition.
    const code = sql.replace(/^\s*--.*$/gm, '');

    for (const m of code.matchAll(/\bdrop\s+view\s+(?:if\s+exists\s+)?(\w+)/gi)) {
      live.delete(m[1]);
    }
    for (const m of code.matchAll(/\bcreate\s+(?:or\s+replace\s+)?view\s+(\w+)/gi)) {
      const name = m[1];
      if (live.has(name)) {
        dupes += 1;
        fail(
          `${name} is created in ${f} and was already created in ${live.get(name)} with no ` +
            `drop between. Extend the existing view; a second one of the same name is the ` +
            `case Postgres catches by accident, at apply time, after both are committed.`,
        );
      }
      live.set(name, f);
    }
  }

  if (dupes === 0) pass(`${live.size} views, none created twice without a drop between`);
}

// ── 3. Column-set overlap between live views ────────────────────────────────────
if (!dbUrl) {
  console.log('\n  · column-overlap check skipped — no database url given.');
  console.log('    Static checks alone cannot see two views with different names and the');
  console.log('    same columns, which is the shape v_shot_readiness had. CI runs this with');
  console.log('    a url after the migrations step.\n');
} else {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const { rows } = await client.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name in (select table_name from information_schema.views where table_schema = 'public')
      order by table_name, ordinal_position`,
  );
  await client.end();

  const cols = new Map();
  for (const r of rows) {
    if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
    cols.get(r.table_name).add(r.column_name);
  }

  const names = [...cols.keys()].sort();
  const flagged = [];

  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = cols.get(names[i]);
      const b = cols.get(names[j]);
      const shared = [...a].filter((c) => b.has(c));
      const containment = shared.length / Math.min(a.size, b.size);

      // Four shared columns and 80% of the smaller view. Two views sharing `id` and a
      // foreign key are joined, not duplicated; two sharing almost everything are one idea
      // written twice.
      if (shared.length >= 4 && containment >= 0.8) {
        flagged.push({ key: `${names[i]}::${names[j]}`, shared, containment });
      }
    }
  }

  const used = new Set();
  for (const f of flagged) {
    if (EXEMPTIONS[f.key]) {
      used.add(f.key);
      pass(`${f.key} — overlap allowed: ${EXEMPTIONS[f.key].slice(0, 72)}…`);
    } else {
      fail(
        `${f.key} share ${f.shared.length} columns (${Math.round(f.containment * 100)}% of the ` +
          `smaller): ${f.shared.slice(0, 6).join(', ')}. Either extend one and delete the ` +
          `other, or add the pair to EXEMPTIONS with a reason saying why they are not the ` +
          `same concept.`,
      );
    }
  }

  for (const key of Object.keys(EXEMPTIONS)) {
    if (!used.has(key)) {
      fail(`${key} is exempted and no longer overlaps. Remove the exemption — one that outlives its cause is a claim nobody re-examines.`);
    }
  }

  if (flagged.length === 0 && Object.keys(EXEMPTIONS).length === 0) {
    pass(`${names.length} views, no substantial column overlap`);
  } else if (failures === 0) {
    pass(`${names.length} views checked; ${flagged.length} overlapping pair(s), each justified`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} failure(s).\n`);
  process.exit(1);
}
console.log('No concept is implemented twice.\n');
