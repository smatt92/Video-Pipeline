import { serverClient } from '@/lib/db/server';

/**
 * The two counts that should always be zero.
 *
 * `v_unconfirmed_terminal_generations` is a generation whose outcome was written without
 * the vendor being asked to confirm it — the shape of a forged callback landing.
 * `v_replayed_callbacks` is a job that received more than one delivery.
 *
 * Both existed only as views, which means both required somebody to remember to run a
 * query. An alert nobody is scheduled to look at is not an alert; if the highest-signal
 * evidence in the system that something is wrong lives in a SQL file, it will be read for
 * the first time while investigating the incident it would have prevented.
 *
 * ── Three states, not two ────────────────────────────────────────────────────
 *
 * Zero renders nothing at all. Non-zero renders loudly. And a query that *fails* renders a
 * third thing, quietly, rather than nothing — because "no alert" and "the alert cannot be
 * read" are different facts and collapsing them makes silence unfalsifiable. On a database
 * without migration 0013/0015 applied the views do not exist, and that is exactly when it
 * matters that this says so instead of looking calm.
 */

interface Integrity {
  unconfirmed: number;
  replayed: number;
  unreadable: string | null;
}

async function readIntegrity(): Promise<Integrity> {
  try {
    const db = serverClient();

    const [unconfirmed, replayed] = await Promise.all([
      db.from('v_unconfirmed_terminal_generations').select('id', { count: 'exact', head: true }),
      db.from('v_replayed_callbacks').select('id', { count: 'exact', head: true }),
    ]);

    const failure = unconfirmed.error ?? replayed.error;
    if (failure) return { unconfirmed: 0, replayed: 0, unreadable: failure.message };

    return {
      unconfirmed: unconfirmed.count ?? 0,
      replayed: replayed.count ?? 0,
      unreadable: null,
    };
  } catch (err) {
    return {
      unconfirmed: 0,
      replayed: 0,
      unreadable: err instanceof Error ? err.message : 'unknown error',
    };
  }
}

export async function IntegrityAlert() {
  const { unconfirmed, replayed, unreadable } = await readIntegrity();

  if (unreadable) {
    return (
      <span
        className="rounded-sm px-2 py-1 font-mono text-3xs"
        style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
        title={`The integrity views could not be read: ${unreadable}. Usually means the migrations have not been applied to this database — run pnpm doctor.`}
        data-integrity="unreadable"
      >
        integrity check unavailable
      </span>
    );
  }

  // The ordinary case, and the reason this is worth having: nothing on screen at all.
  if (unconfirmed === 0 && replayed === 0) return null;

  const parts: string[] = [];
  if (unconfirmed > 0) {
    parts.push(`${unconfirmed} result${unconfirmed === 1 ? '' : 's'} written without confirmation`);
  }
  if (replayed > 0) {
    parts.push(`${replayed} job${replayed === 1 ? '' : 's'} with repeat callbacks`);
  }

  return (
    <span
      className="rounded-sm px-2 py-1 text-2xs font-medium"
      style={{
        // The review state's colour, not the accent. This is not a call to action in the
        // pipeline's normal sense — it says something may be wrong with the pipeline
        // itself, and it should not read as one more thing in the queue.
        background: 'var(--surface-inset)',
        color: 'var(--state-review)',
        border: '1px solid var(--border-strong)',
      }}
      title={
        unconfirmed > 0
          ? 'A generation reached a terminal state without the vendor confirming it. The callback carries a shared secret rather than a signature, so this is what a forged completion looks like. Investigate before trusting any asset it produced.'
          : 'A job received more than one callback. A vendor retry after a timeout is ordinary and harmless — the confirmation is compare-and-set, so a replay changes nothing. A long gap between the first and last delivery is not ordinary.'
      }
      data-integrity="alert"
    >
      {parts.join(' · ')}
    </span>
  );
}
