import { serverClient, type Db } from '../db/server';

import { readQuota, type QuotaWindow } from './quota';

/**
 * What the `/publish` screen reads.
 *
 * ── The inverse test, built in rather than retrofitted ───────────────────────
 *
 * A publish queue that renders identically after one upload and after a hundred is the trap
 * the operator named up front, and this project has now found that shape five times. So
 * nothing here returns a bare list. Every read is anchored on counts, and the counts come
 * from the whole table rather than from the rows being displayed — which is the specific
 * failure a `.limit()` produces: a list that is correct about the rows it shows and silent
 * about the ones it dropped.
 *
 * `queueTotal` is therefore read with `count: 'exact', head: true` against
 * `v_publish_queue`, not derived from `rows.length`. If those two disagree the screen says
 * so, because a display cap that nobody can see is the thing being guarded against.
 */

export interface PublishRow {
  publicationId: string;
  title: string;
  status: string;
  scheduledFor: string | null;
  uploadAttempts: number;
  uploadBytesSent: number | null;
  uploadTotalBytes: number | null;
  alteredContentDisclosed: boolean;
  reviewDecision: string | null;
  renderStatus: string | null;
  errorDetail: string | null;
  /** Null means nothing is stopping it. The first reason, earliest-stage first. */
  blocker: string | null;
}

export interface CredentialHealth {
  channelId: string;
  name: string;
  lastRefreshedAt: string | null;
  refreshError: string | null;
  consecutiveFailures: number;
  accessTokenExpiresAt: string | null;
}

export interface PublishBoard {
  rows: PublishRow[];
  /** Every row in the queue, counted in the database. Never `rows.length`. */
  queueTotal: number;
  /** Live publications. The other half of the denominator: what HAS shipped. */
  liveTotal: number;
  byBlocker: Record<string, number>;
  /** Null when no integration declares a quota — not zero remaining. */
  quota: QuotaWindow | null;
  quotaUnavailableReason: string | null;
  credentials: CredentialHealth[];
  unreadable: string[];
}

/** How many rows the screen renders. Stated, and compared against the true count below. */
export const QUEUE_PAGE = 50;

export async function readPublishBoard(client?: Db): Promise<PublishBoard> {
  const db = client ?? serverClient();
  const unreadable: string[] = [];

  const [rows, queueCount, liveCount, quota, channels] = await Promise.all([
    db
      .from('v_publish_queue')
      // One string literal rather than a concatenation: supabase-js infers the row type
      // from the literal, and `'a, ' + 'b'` collapses it to GenericStringError — every
      // field then fails to typecheck for a reason that names none of this.
      .select('publication_id, title, status, scheduled_for, upload_attempts, upload_bytes_sent, upload_total_bytes, altered_content_disclosed, review_decision, render_status, error_detail, blocker')
      .order('scheduled_for', { ascending: true, nullsFirst: false })
      .limit(QUEUE_PAGE),
    // The denominator, counted in the database over the whole view. This is the line that
    // makes the cap visible instead of silent.
    db.from('v_publish_queue').select('publication_id', { count: 'exact', head: true }),
    db.from('publications').select('id', { count: 'exact', head: true }).eq('status', 'live'),
    readQuota(db, 'youtube'),
    db
      .from('channels')
      .select('id, name, token_last_refreshed_at, token_refresh_error, token_refresh_failures, token_expires_at')
      .eq('is_active', true),
  ]);

  for (const [name, res] of [
    ['v_publish_queue', rows],
    ['v_publish_queue (count)', queueCount],
    ['publications', liveCount],
    ['channels', channels],
  ] as const) {
    if (res.error) unreadable.push(`${name}: ${res.error.message}`);
  }

  const mapped: PublishRow[] = (rows.data ?? []).map((r) => ({
    publicationId: r.publication_id as string,
    title: r.title as string,
    status: r.status as string,
    scheduledFor: r.scheduled_for as string | null,
    uploadAttempts: Number(r.upload_attempts ?? 0),
    // Null, not 0. "No bytes have been sent" and "we do not know how many were sent" are
    // different, and the second is what a resumable session reports when the position is
    // unknown — treating it as 0 re-sends a whole video and spends 1,600 units.
    uploadBytesSent: r.upload_bytes_sent === null ? null : Number(r.upload_bytes_sent),
    uploadTotalBytes: r.upload_total_bytes === null ? null : Number(r.upload_total_bytes),
    alteredContentDisclosed: r.altered_content_disclosed as boolean,
    reviewDecision: r.review_decision as string | null,
    renderStatus: r.render_status as string | null,
    errorDetail: r.error_detail as string | null,
    blocker: r.blocker as string | null,
  }));

  const byBlocker: Record<string, number> = {};
  for (const row of mapped) {
    const key = row.blocker ?? 'ready';
    byBlocker[key] = (byBlocker[key] ?? 0) + 1;
  }

  return {
    rows: mapped,
    queueTotal: queueCount.count ?? 0,
    liveTotal: liveCount.count ?? 0,
    byBlocker,
    quota: quota.ok ? quota.window : null,
    // The reason, not just the absence. "No quota is being counted for this vendor" and
    // "the quota view could not be read" send you to different places.
    quotaUnavailableReason: quota.ok ? null : quota.detail,
    credentials: (channels.data ?? []).map((c) => ({
      channelId: c.id as string,
      name: c.name as string,
      lastRefreshedAt: c.token_last_refreshed_at as string | null,
      refreshError: c.token_refresh_error as string | null,
      consecutiveFailures: Number(c.token_refresh_failures ?? 0),
      accessTokenExpiresAt: c.token_expires_at as string | null,
    })),
    unreadable,
  };
}
