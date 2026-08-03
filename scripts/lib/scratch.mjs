/**
 * A throwaway database with the migrations applied, created and dropped per run.
 *
 * Every harness in this repo asserts something about *absence* at some point — an empty
 * prompt library, no scripts, no shots, no ledger rows — and an absence assertion is only
 * meaningful on a database nothing has touched. Run twice against a shared database and
 * those assertions fail on rows the first run wrote, which is the harness correctly
 * reporting that the harness was lying.
 *
 * `verify-assemble` had the other half of the same problem: it writes fixtures under fixed
 * UUIDs and tears them down at the end, so a second run against the same database died on a
 * foreign key from the `renders` row the first run left behind. It passed in CI, where the
 * database is always fresh, and failed for anyone who ran it twice — which is the worst
 * shape for a defect to have, because the person who hits it is the one being told the
 * tooling is reliable.
 *
 * One helper rather than a copy per harness. Four copies of a twenty-line block is drift
 * waiting to happen, and the whole argument of `check:gates` is that duplicated guard
 * machinery is how guards quietly stop guarding.
 *
 * Requires CREATE DATABASE on the URL it is given. That is the same privilege
 * `check:catalog` has always needed.
 */

import { listMigrations } from './migrations.mjs';
import { classifyConnectionError, describeSqlError, tryConnect } from './pg.mjs';

/**
 * @param {string} adminUrl  A URL that can CREATE DATABASE.
 * @param {string} label     Short name, used in the scratch database's name.
 * @returns {Promise<{ client: import('pg').Client, url: string, release: () => Promise<void> }>}
 */
export async function scratchDatabase(adminUrl, label) {
  const name = `kiln_${label}_${process.pid}`;
  const url = withDatabase(adminUrl, name);

  const admin = await tryConnect(adminUrl);
  if (!admin.ok) {
    const why = classifyConnectionError(admin.error, adminUrl);
    console.error(`\nCannot connect: ${why.cause ?? admin.error.message}\n${why.remedy ?? ''}\n`);
    process.exit(2);
  }

  // CREATE DATABASE cannot run inside a transaction block, which is why this gets its own
  // connection rather than borrowing a pooled one.
  await admin.client.query(`drop database if exists ${name} with (force)`);
  await admin.client.query(`create database ${name}`);
  await admin.client.end();

  const connection = await tryConnect(url);
  if (!connection.ok) {
    console.error(`Could not connect to the scratch database: ${connection.error.message}`);
    process.exit(2);
  }

  for (const migration of listMigrations()) {
    try {
      await connection.client.query(migration.sql);
    } catch (err) {
      console.error(`\nMigration ${migration.file} failed on an empty database:\n`);
      console.error(describeSqlError(err, migration.sql));
      process.exit(1);
    }
  }

  return {
    client: connection.client,
    url,
    /** Idempotent, and safe to call after a failure. Called from a finally, always. */
    async release() {
      await connection.client.end().catch(() => {});
      const cleanup = await tryConnect(adminUrl);
      if (cleanup.ok) {
        // Left behind after every failed run is how a machine acquires forty of these.
        await cleanup.client.query(`drop database if exists ${name} with (force)`).catch(() => {});
        await cleanup.client.end().catch(() => {});
      }
    },
  };
}

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
