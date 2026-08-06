#!/usr/bin/env node
/**
 * `pacing_template` may hold numbers and shapes. It may never hold a sentence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this guard exists when no write path can produce the state it forbids
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This codebase normally treats that as a defect. `check:guardrails` was built partly to
 * find guards protecting states that cannot occur, and a fourth workspace gate was dropped
 * for exactly this reason one round ago.
 *
 * This is the documented exception, and the difference is the tense. Those guards asked
 * "can this happen?" and the answer was no, so they measured nothing. This one asserts
 * that it must **never become possible** — the guard is not checking today's schema, it is
 * the specification for every future migration, enforced.
 *
 * ── What it is protecting against ────────────────────────────────────────────
 *
 * Addendum 04 §6 rejects feeding competitors' transcripts to the script writer. YouTube's
 * inauthentic-content policy names readings of material you did not create as an explicit
 * violation, and Kiln's own script provenance record would be the evidence against it in
 * an appeal. The safe version keeps most of the value by extracting *structure* — beats,
 * hook length, where the first tension release falls, claim-to-example ratio.
 *
 *   **Structure is not copyrightable. Sentences are.**
 *
 * The failure this prevents is not somebody maliciously pasting a transcript into the
 * database. It is somebody adding `source_excerpt text` in eight months, for a perfectly
 * good debugging reason, with a helpful comment — and the line being crossed by a column
 * nobody reviewed against a policy document they have not read. A text column on this
 * table is a legal exposure wearing the costume of a convenience.
 *
 * ── It asks whether a column can hold PROSE, not whether it is typed text ────
 *
 * The first version checked the type and failed on `cta_position` and `arc` — the two
 * CHECK-constrained enums the spec explicitly permits, because Postgres models a closed
 * vocabulary as `text` plus a constraint. That is this project's own wrong-quantity
 * failure committed inside a guard: the claim is "this column cannot hold a sentence" and
 * the type is only a proxy for it.
 *
 * So a text column passes exactly when a CHECK confines it to an enumerated set — the
 * `= ANY (ARRAY[...])` shape, the same one `check:enums` learned to recognise for the same
 * reason. `check (arc <> '')` is a constraint and not a vocabulary, and does not count.
 * This is stricter than the type rule in the direction that matters and looser only where
 * the value provably cannot be prose.
 *
 * ── One exemption, and it is narrow ──────────────────────────────────────────
 *
 * `extractor_version` is unconstrained text and names the code that measured, not the
 * video that was measured. It is listed by name rather than by pattern, so a future
 * `source_version` or `notes_version` does not slip through on a suffix.
 *
 * ── Why it reads the database rather than the migration files ────────────────
 *
 * A regex over `supabase/migrations/*.sql` would be a parser, and a parser that is wrong in
 * one direction produces false confidence — the same argument `check:duplicates` makes for
 * reading `information_schema` instead of parsing view SQL. Applied schema is the thing
 * that matters; a column added by a migration this script failed to parse is exactly the
 * column it must catch.
 *
 * Usage: node scripts/check-pacing-columns.mjs <db-url>
 */
import { withClient } from './lib/pg.mjs';

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/check-pacing-columns.mjs <db-url>');
  process.exit(2);
}

const TABLE = 'pacing_template';

/** Types that can carry prose. `citext` and the array forms are included deliberately. */
const TEXTUAL = new Set([
  'text', 'character varying', 'character', 'citext', 'json', 'jsonb', 'xml',
  'ARRAY', 'USER-DEFINED',
]);

/** By name, never by pattern — a suffix rule would admit `source_version`. */
const EXEMPT = new Set(['extractor_version']);

const { rows, enumerated } = await withClient(dbUrl, async (client) => {
  const { rows: cols } = await client.query(
    `select column_name, data_type, udt_name
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by ordinal_position`,
    [TABLE],
  );
  // Which single-column CHECKs confine a column to an enumerated set. Single-column
  // because a constraint spanning several is a relationship between them rather than a
  // vocabulary for one — the distinction check:enums had to learn the hard way.
  const { rows: checks } = await client.query(
    `select att.attname as column_name, pg_get_constraintdef(con.oid) as def
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace nsp on nsp.oid = rel.relnamespace
       join unnest(con.conkey) as k(attnum) on true
       join pg_attribute att on att.attrelid = rel.oid and att.attnum = k.attnum
      where con.contype = 'c' and nsp.nspname = 'public' and rel.relname = $1
        and array_length(con.conkey, 1) = 1`,
    [TABLE],
  );
  const closed = new Set(
    checks.filter((c) => /=\s*ANY\s*\(ARRAY\[/i.test(c.def)).map((c) => c.column_name),
  );
  return { rows: cols, enumerated: closed };
}).catch((err) => {
  console.error(`could not query the database: ${err.message}`);
  process.exit(2);
});

console.log('\npacing_template — structure only, never sentences\n');

// The table's absence is not a pass. Exit 2 rather than 0: a run that never found the
// table has no opinion about its columns, and reporting "no text columns" would be the
// clean-answer-to-a-question-nobody-asked failure this project keeps finding.
if (rows.length === 0) {
  console.error(
    `  There is no "${TABLE}" table in this database, so this check has no opinion.\n\n` +
      '  That is NOT a pass. Apply the migrations first: pnpm db:push "<db-url>"\n\n' +
      '  Exit 2, because 1 would mean "a forbidden column exists" and this run never got\n' +
      '  far enough to know.\n',
  );
  process.exit(2);
}

const offending = rows.filter(
  (c) =>
    TEXTUAL.has(c.data_type)
    && !EXEMPT.has(c.column_name)
    // A closed vocabulary is a shape, not a sentence. This is the whole predicate.
    && !enumerated.has(c.column_name),
);

for (const c of rows) {
  const mark = offending.includes(c)
    ? '✗'
    : EXEMPT.has(c.column_name)
      ? '~'
      : '✓';
  const note = enumerated.has(c.column_name)
    ? '  (closed vocabulary)'
    : EXEMPT.has(c.column_name)
      ? '  (exempt by name — names the extractor, not the video)'
      : '';
  console.log(`  ${mark} ${c.column_name.padEnd(24)} ${c.data_type}${note}`);
}
console.log();

if (offending.length > 0) {
  console.error(
    `${offending.length} column(s) on ${TABLE} can hold text:\n\n` +
      offending.map((c) => `  ✗ ${c.column_name} (${c.data_type})`).join('\n') +
      '\n\n' +
      'Addendum 04 §6: this table holds structure extracted from videos we did not make.\n' +
      'Structure is not copyrightable and sentences are, and a text column here crosses\n' +
      'that line silently — the row looks like every other row and only its contents\n' +
      'differ. YouTube\'s inauthentic-content policy names readings of material you did\n' +
      'not create as an explicit violation, and this project\'s own provenance record\n' +
      'would be the evidence against it.\n\n' +
      'If the thing you are recording is genuinely a shape, express it as a number or as\n' +
      'a CHECK-constrained enum — a text column confined by `= ANY (ARRAY[...])` passes,\n' +
      'because a closed vocabulary cannot hold a sentence. If it is genuinely prose, it\n' +
      'does not belong on this table at all.\n',
  );
  process.exit(1);
}

// The positive control. Without it, a rename of the table, a schema change, or a typo in
// TEXTUAL would report a clean run for every future migration — an absence result is only
// evidence when the instrument is known to be able to see the thing.
const canSeeTypes = rows.some((c) => c.data_type === 'text' || c.data_type === 'numeric');
// Both halves of the predicate must be demonstrably working. Without the second, a query
// that silently returned no constraints would mark every enum as offending — loud and
// obvious — but a query that returned ALL columns as enumerated would pass everything,
// silently, for ever. That is the direction that needs the control.
const canSeeVocabularies = enumerated.size > 0 && enumerated.size < rows.length;
if (!canSeeTypes || !canSeeVocabularies) {
  console.error(
    'The probe is not working, so its answer means nothing.\n\n' +
      `  recognisable column types read: ${canSeeTypes} (expected true)\n` +
      `  closed vocabularies found:      ${enumerated.size} of ${rows.length} columns ` +
      '(expected: some, but not all)\n\n' +
      'Fix the check before trusting a clean run.\n',
  );
  process.exit(1);
}

console.log(
  `  ${rows.length} columns · ${enumerated.size} closed vocabularies · ${EXEMPT.size} exempt ` +
    'by name · none that can hold a sentence.\n',
);
console.log(
  'This guard protects a state no write path produces, on purpose. The point is not that\n' +
    'it is reachable today — it is that none ever should be, and a guard is the only form\n' +
    'that sentence survives in.\n',
);
