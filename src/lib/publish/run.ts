import type { Db } from '../db/server';

import { spend, settle } from './quota';
import {
  fetchAccessToken,
  openUploadSession,
  sendUpload,
  type OauthApp,
  type VideoMetadata,
} from './youtube';

/**
 * Stage 10, as a plain function. The Trigger task is a wrapper, as in every other stage.
 *
 * ── Every refusal is here, not in the task ───────────────────────────────────
 *
 * CLAUDE.md, learned the expensive way: the seven `throw`s in `src/trigger/` have no
 * coverage of any kind, because no harness imports a task, and `verify:submit` proved that
 * adding assertions cannot reach them. So the task resolves configuration and hands it
 * down; this decides. Everything below can be driven by `verify:publish` with a deps
 * object.
 *
 * ── The gate is the database's, and this does not duplicate it ───────────────
 *
 * `enforce_review_pass` is a trigger on `publications` (rule 7): moving a row to
 * scheduled/uploading/live with a review that is not a pass raises. This function reads
 * `v_publish_queue.blocker` and refuses early — but that is a *message*, not the gate. The
 * distinction matters and is asserted in the harness both ways: if this check were ever
 * removed the upload would still be impossible, and if the trigger were ever removed this
 * check would not save it. No override flag of any kind exists, and no code path sets
 * status without going through the trigger.
 *
 * That sentence used to name the two flags it was denying, and `verify:publish` §3 failed
 * on it — the assertion greps `src/` for exactly those shapes and cannot tell a comment
 * from a line of code. The comment was reworded rather than the guard narrowed, which is
 * the precedent the vendor-isolation check already set: a guard that ignores comments would
 * equally ignore a commented-out override, and the wording costs nothing.
 *
 * ── Bytes never touch Vercel ─────────────────────────────────────────────────
 *
 * Rule 2. The worker fetches the render from the bucket by presigned GET and streams it to
 * the vendor. `downloadRender` is a dependency rather than an import so the harness can
 * supply bytes without an S3 endpoint — the byte-moving helper itself lives in the storage
 * driver and is imported only by `src/trigger/`.
 */

export interface PublishPayload {
  publicationId: string;
  /** Rule 6. Two videos on a channel is worse than a failed publish: an audience sees it. */
  idempotencyKey: string;
}

export interface PublishDeps {
  db: Db;
  app: OauthApp;
  /** Presigned GET → bytes. Supplied by the task; never an import here. */
  downloadRender: (renderId: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void };
}

export type PublishResult =
  | { ok: true; videoId: string; url: string; unitsSpent: number }
  | { ok: false; code: string; detail: string; unitsSpent: number };

const noop = { info: () => {}, warn: () => {} };

/** The vendor's own name for the call, so the ledger row and their price list agree. */
const INSERT_ENDPOINT = 'videos.insert' as const;
const PUBLISH_SLUG = 'youtube';

export async function publishVideo(
  payload: PublishPayload,
  deps: PublishDeps,
): Promise<PublishResult> {
  const { db, app } = deps;
  const log = deps.log ?? noop;
  const now = deps.now ?? (() => new Date());

  // ── 1. Is this publication allowed to move at all? ─────────────────────────
  //
  // Read from the view rather than re-derived here. Two implementations of "what blocks a
  // publish" is the collision this project keeps finding: the screen would show one answer
  // and the task would act on another, and the disagreement is invisible until somebody
  // stares at a queue that says ready beside a task that refuses.
  const { data: queued, error: queueErr } = await db
    .from('v_publish_queue')
    .select('publication_id, blocker, render_id, title, altered_content_disclosed, status')
    .eq('publication_id', payload.publicationId)
    .maybeSingle();

  if (queueErr) {
    return { ok: false, code: 'queue_unreadable', detail: queueErr.message, unitsSpent: 0 };
  }
  if (!queued) {
    // Either it does not exist or it is already live. Distinguished, because "publish a
    // video that is already published" is a replay and must not read as a missing row.
    const { data: existing } = await db
      .from('publications')
      .select('id, status, external_post_id, external_url')
      .eq('id', payload.publicationId)
      .maybeSingle();
    if (existing?.status === 'live') {
      return {
        ok: false,
        code: 'already_live',
        detail:
          `Publication ${payload.publicationId} is already live at `
          + `${existing.external_url ?? existing.external_post_id ?? 'an unrecorded URL'}. `
          + 'Refusing rather than uploading a second copy, which an audience would see and '
          + 'only a human could undo.',
        unitsSpent: 0,
      };
    }
    return {
      ok: false,
      code: 'no_such_publication',
      detail: `No publication ${payload.publicationId}.`,
      unitsSpent: 0,
    };
  }

  if (queued.blocker !== null) {
    return {
      ok: false,
      code: `blocked_${queued.blocker}`,
      detail:
        `The publish queue reports "${queued.blocker}" for this publication. Refusing here `
        + 'so the reason a person sees on the screen is the reason the task acted on — the '
        + 'view and this function must never disagree about what is ready.',
      unitsSpent: 0,
    };
  }

  // ── 2. Idempotency, claimed in the database ────────────────────────────────
  //
  // A compare-and-set on a unique index, not a read-then-write. Two workers replaying the
  // same payload both pass a `select ... where idempotency_key is null`; only one can win
  // the insert. The same shape as approving a pilot and confirming a generation, for the
  // same reason: the losing side must lose in the database rather than in a race.
  const { error: claimErr } = await db
    .from('publications')
    .update({ idempotency_key: payload.idempotencyKey })
    .eq('id', payload.publicationId)
    .is('idempotency_key', null);

  if (claimErr) {
    return {
      ok: false,
      code: 'idempotency_conflict',
      detail:
        `This publish has already been claimed under key "${payload.idempotencyKey}". `
        + `${claimErr.message}`,
      unitsSpent: 0,
    };
  }

  // ── 3. A token, and what its failure means ─────────────────────────────────
  const token = await fetchAccessToken(app, deps.fetchImpl);
  if (!token.ok) {
    // A revoked credential is a different row from a network blip, because it needs a
    // human. Recorded on the channel so the cron's alerting and this share one signal.
    if (token.credentialRevoked) {
      await db
        .from('channels')
        .update({ token_refresh_error: token.detail })
        .eq('id', (await channelOf(db, payload.publicationId)) ?? '');
    }
    return {
      ok: false,
      code: token.credentialRevoked ? 'credential_revoked' : 'token_failed',
      detail: token.detail,
      unitsSpent: 0,
    };
  }

  // ── 4. Commit the quota BEFORE the call ────────────────────────────────────
  //
  // Rule 5's shape for units. The vendor charges a refused attempt, so a process that dies
  // between the call and the row leaves the day's remaining figure over-reporting until
  // midnight Pacific.
  const committed = await spend(db, PUBLISH_SLUG, INSERT_ENDPOINT, {
    publicationId: payload.publicationId,
    detail: `resumable upload for "${queued.title}"`,
  });
  if (!committed.ok) {
    return { ok: false, code: committed.code, detail: committed.detail, unitsSpent: 0 };
  }

  const metadata = await metadataFor(db, payload.publicationId);
  if (!metadata.ok) {
    await settle(db, committed.usageId, false, metadata.detail);
    return { ok: false, code: metadata.code, detail: metadata.detail, unitsSpent: 1600 };
  }

  // ── 5. The bytes, from the bucket, in the worker ───────────────────────────
  let media: { bytes: Uint8Array; contentType: string };
  try {
    media = await deps.downloadRender(queued.render_id as string);
  } catch (err) {
    await settle(db, committed.usageId, false, 'render download failed');
    return {
      ok: false,
      code: 'render_unreadable',
      detail: err instanceof Error ? err.message : String(err),
      unitsSpent: 1600,
    };
  }

  await db
    .from('publications')
    .update({
      status: 'uploading',
      upload_started_at: now().toISOString(),
      upload_total_bytes: media.bytes.byteLength,
      upload_bytes_sent: 0,
    })
    .eq('id', payload.publicationId);

  const session = await openUploadSession(
    token.accessToken,
    metadata.value,
    media.bytes.byteLength,
    media.contentType,
    deps.fetchImpl,
  );

  if (!session.ok) {
    // A 403 quotaExceeded is the moment the documented ceiling becomes observable. Recorded
    // as such rather than as a generic failure, because it is the only evidence that will
    // ever exist for the real number.
    if (session.quotaExceeded) {
      await db
        .from('integrations')
        .update({ quota_source: 'observed', last_error: session.detail })
        .eq('slug', PUBLISH_SLUG);
      log.warn('the documented quota ceiling was refused, so it is now observed', {
        detail: session.detail,
      });
    }
    await settle(db, committed.usageId, false, session.detail);
    await failPublication(db, payload.publicationId, session.code, session.detail);
    return { ok: false, code: session.code, detail: session.detail, unitsSpent: 1600 };
  }

  await db
    .from('publications')
    .update({ upload_session_url: session.sessionUrl })
    .eq('id', payload.publicationId);

  const sent = await sendUpload(
    session.sessionUrl,
    media.bytes,
    media.bytes.byteLength,
    0,
    media.contentType,
    deps.fetchImpl,
  );

  if (!sent.ok) {
    await settle(db, committed.usageId, false, sent.detail);
    // The session URL is deliberately NOT cleared. It is what makes the retry cost nothing:
    // continuing an open session spends no further units, and starting again spends 1,600.
    await db
      .from('publications')
      .update({
        upload_attempts: (await attemptsOf(db, payload.publicationId)) + 1,
        upload_bytes_sent: sent.resumeFrom,
        status: 'failed',
        error_detail: `${sent.code}: ${sent.detail}`,
      })
      .eq('id', payload.publicationId);
    return { ok: false, code: sent.code, detail: sent.detail, unitsSpent: 1600 };
  }

  await settle(db, committed.usageId, true);

  const { error: liveErr } = await db
    .from('publications')
    .update({
      status: 'live',
      external_post_id: sent.videoId,
      external_url: sent.url,
      published_at: now().toISOString(),
      upload_bytes_sent: media.bytes.byteLength,
      upload_session_url: null,
      error_detail: null,
    })
    .eq('id', payload.publicationId);

  if (liveErr) {
    // The video IS on the channel. Saying otherwise would be worse than the error: the next
    // run would upload a second copy. Reported as a reconciliation problem with the id in it.
    return {
      ok: false,
      code: 'published_but_unrecorded',
      detail:
        `The upload succeeded and the row could not be updated: ${liveErr.message}. The `
        + `video EXISTS at ${sent.url} — do not re-run this publish, reconcile the row. `
        + 'Its id is recorded on the quota ledger row for this publication.',
      unitsSpent: 1600,
    };
  }

  log.info('published', { videoId: sent.videoId, unitsSpent: 1600 });
  return { ok: true, videoId: sent.videoId, url: sent.url, unitsSpent: 1600 };
}

async function channelOf(db: Db, publicationId: string): Promise<string | null> {
  const { data } = await db
    .from('publications')
    .select('channel_id')
    .eq('id', publicationId)
    .maybeSingle();
  return (data?.channel_id as string | undefined) ?? null;
}

async function attemptsOf(db: Db, publicationId: string): Promise<number> {
  const { data } = await db
    .from('publications')
    .select('upload_attempts')
    .eq('id', publicationId)
    .maybeSingle();
  return Number(data?.upload_attempts ?? 0);
}

async function failPublication(db: Db, id: string, code: string, detail: string) {
  await db
    .from('publications')
    .update({ status: 'failed', error_detail: `${code}: ${detail}` })
    .eq('id', id);
}

type MetadataResult =
  | { ok: true; value: VideoMetadata }
  | { ok: false; code: string; detail: string };

/**
 * Build the upload metadata from the row.
 *
 * The disclosure is read from the column and refused when false, rather than defaulted to
 * true. Defaulting would be the friendlier code and the wrong control: the column exists so
 * that a human decision is recorded, and a default turns it into a decision nobody made.
 */
async function metadataFor(db: Db, publicationId: string): Promise<MetadataResult> {
  const { data, error } = await db
    .from('publications')
    .select('title, description, tags, altered_content_disclosed, scheduled_for')
    .eq('id', publicationId)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, code: 'metadata_unreadable', detail: error?.message ?? 'no row' };
  }

  if (data.altered_content_disclosed !== true) {
    return {
      ok: false,
      code: 'disclosure_not_set',
      detail:
        'altered_content_disclosed is not true on this publication. Every video this '
        + 'pipeline makes is generated, so the disclosure is not optional — and it is '
        + 'refused rather than defaulted, because a default records a decision nobody made.',
    };
  }

  return {
    ok: true,
    value: {
      title: data.title as string,
      description: (data.description as string | null) ?? '',
      tags: (data.tags as string[] | null) ?? [],
      alteredContentDisclosed: true,
      // Private on upload, always. A generated video going straight to public on a task's
      // say-so removes the last point at which a person can look at it on the platform
      // itself — where it looks different from the review screen.
      privacyStatus: 'private',
      madeForKids: false,
    },
  };
}
