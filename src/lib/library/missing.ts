/**
 * The one sentence a Library screen shows when migration 0046 has not been pasted into the
 * hosted project yet. Shared so the three screens and their actions say the same thing, and
 * so the test for "is this the missing-table error" is written once.
 *
 * A missing table is not "no rows": an empty voices list on a database that cannot hold an
 * override would read as "nobody has overridden anything", which is a claim about a table
 * that does not exist.
 */
export const NEEDS_0046 = 'needs migration 0046 — paste docs/bureau/hosted-migrations-5-0046.sql';

/** PostgREST says "schema cache"; Postgres (and the harness shim) says "does not exist". */
export function isMissingTable(error: { message: string } | null | undefined): boolean {
  return !!error && /does not exist|schema cache/i.test(error.message);
}
