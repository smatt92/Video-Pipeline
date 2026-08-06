#!/usr/bin/env node
/**
 * Stage 10 — publishing, against a real database and a real HTTP server.
 *
 * PROVES:  the disclosure reaches the vendor payload as the field the API actually names,
 *          and a publication without it is refused rather than defaulted; the database gate
 *          refuses a publish with no passing review even when the application check is
 *          bypassed; a quota row is written BEFORE the call and is not refunded when the
 *          call fails; an upload is refused before it spends when the day's units cannot
 *          cover it; a replay does not put a second video on the channel; a 403
 *          quotaExceeded turns the documented ceiling into an observed one; a dead refresh
 *          token is distinguished from a network failure; and the queue's count comes from
 *          the database rather than from the rows on screen.
 *
 * ── The two sections that carry the others ───────────────────────────────────
 *
 * **§3 is LOAD-BEARING.** Every other assertion about readiness reads `v_publish_queue`,
 * which is also what `publishVideo` reads — one source agreeing with itself. §3 is the only
 * place the *database* is asked independently: it sets a publication's review to a
 * non-pass and drives the status transition directly in SQL, past the application entirely.
 * If that ever succeeds, `enforce_review_pass` has stopped being a gate and every other
 * green assertion here is describing a check with nothing behind it.
 *
 * **§6 drives the accepting branch, not only the refusal.** A guard whose test exercises
 * only its refusal passes on an empty database whatever the accept branch does. So the
 * quota assertions run an upload that succeeds and check the units were still spent, as
 * well as one that is refused.
 *
 * The vendor is a local HTTP server. It is not a mock object: `publishVideo` performs real
 * fetches against real status codes and headers, including the `Location` header that
 * carries a resumable session and the 403 body that carries a quota refusal. What is
 * synthetic is who answers, which is the line this project draws for every driver.
 *
 * Usage: node scripts/verify-publish.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-publish.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { publishVideo } = require(`${BUILD}/publish/run.js`);
const { readQuota } = require(`${BUILD}/publish/quota.js`);
const { readPublishBoard, QUEUE_PAGE } = require(`${BUILD}/publish/read.js`);
const { checkTokenHealth } = require(`${BUILD}/publish/token-health.js`);
const { insertBody, parseResumeOffset, QUOTA_UNITS } = require(`${BUILD}/publish/youtube.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => { console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const eq = (l, actual, expected) =>
  actual === expected ? ok(l, String(actual)) : bad(l, `expected ${expected}, got ${actual}`);

const scratch = await scratchDatabase(dbUrl, 'publish');
const client = scratch.client;
const db = supabaseShim(client);
const q = (sql, params = []) => client.query(sql, params);

// ── The vendor, answering over real HTTP ───────────────────────────────────────
//
// Scripted per test rather than clever: each section sets `vendor.mode` and the server
// answers accordingly. A configurable stub beats a smart one — a stub that decides for
// itself is a second implementation of the vendor, and then the harness is testing that.
const vendor = { mode: 'ok', sessionsOpened: 0, bytesReceived: 0, tokenCalls: 0 };
let base = '';

const server = createServer((req, res) => {
  const url = req.url ?? '';

  if (url.startsWith('/token')) {
    vendor.tokenCalls += 1;
    if (vendor.mode === 'token_revoked') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'expired' }));
    }
    if (vendor.mode === 'token_network') {
      res.writeHead(503);
      return res.end('upstream unavailable');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ access_token: 'ya29.stub', expires_in: 3599 }));
  }

  if (url.startsWith('/upload')) {
    if (vendor.mode === 'quota_exceeded') {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        error: { code: 403, errors: [{ reason: 'quotaExceeded' }], message: 'quota exceeded' },
      }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      vendor.sessionsOpened += 1;
      vendor.lastInsertBody = body;
      res.writeHead(200, { location: `${base}/session/${vendor.sessionsOpened}` });
      res.end();
    });
  }

  if (url.startsWith('/session/')) {
    let received = 0;
    req.on('data', (c) => { received += c.length; });
    return req.on('end', () => {
      vendor.bytesReceived = received;
      if (vendor.mode === 'upload_interrupted') {
        res.writeHead(308, { range: 'bytes=0-511' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'vid_stub_123', kind: 'youtube#video' }));
    });
  }

  res.writeHead(404);
  res.end();
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;

/** Rewrites the vendor's hostnames onto the local server. The driver's URLs are constants
 *  on purpose — a configurable base URL in production is one more thing that can point
 *  somewhere wrong — so the substitution happens here, in the harness, at the fetch. */
const stubFetch = async (input, init) => {
  const url = String(input)
    .replace('https://oauth2.googleapis.com/token', `${base}/token`)
    .replace('https://www.googleapis.com/upload/youtube/v3/videos', `${base}/upload`);
  return fetch(url, init);
};

const app = { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtok' };
const bytes = new Uint8Array(1024).fill(7);
const downloadRender = async () => ({ bytes, contentType: 'video/mp4' });

console.log('\nStage 10 — publishing\n');

// ═══════════════════════════════════════════════════════════════════════════════
console.log('0. The disclosure reaches the payload as the field the API names\n');
// Asserted against what `insertBody` RETURNS, not against a column the fixtures write.
// The field name was read from the API's own discovery document; getting it wrong produces
// uploads that succeed, look correct, and are undisclosed — with no error anywhere.
{
  const body = insertBody({
    title: 't', description: 'd', tags: [], alteredContentDisclosed: true,
    privacyStatus: 'private', madeForKids: false,
  });
  eq('containsSyntheticMedia is set from the column', body.status.containsSyntheticMedia, true);
  eq('and it is not merely truthy', typeof body.status.containsSyntheticMedia, 'boolean');

  // The half that matters more. An omitted field means "not disclosed" to the vendor, so
  // `false` must travel as `false` rather than vanishing — omission is not a position.
  const undisclosed = insertBody({
    title: 't', description: 'd', tags: [], alteredContentDisclosed: false,
    privacyStatus: 'private', madeForKids: false,
  });
  eq('a false disclosure is sent explicitly, not omitted',
     Object.prototype.hasOwnProperty.call(undisclosed.status, 'containsSyntheticMedia'), true);
  eq('  · with the value false', undisclosed.status.containsSyntheticMedia, false);

  // Private on upload, always — the last point at which a person can see it on the
  // platform, where it looks different from the review screen.
  eq('uploads are private', body.status.privacyStatus, 'private');

  eq('an upload costs what the price list says', QUOTA_UNITS['videos.insert'], 1600);
  // Null, not 0: "the server has nothing" and "we do not know what the server has" differ
  // by 1,600 units, because the second must not restart the upload.
  eq('an absent Range header means unknown, not zero', parseResumeOffset(null), null);
  eq('and a present one is the NEXT byte', parseResumeOffset('bytes=0-511'), 512);
}

// ── Fixtures ───────────────────────────────────────────────────────────────────
const channelId = randomUUID();
await q(
  `insert into channels (id, name, platform, handle, niche)
   values ($1,'Kiln test','youtube','@kiln','test')`,
  [channelId],
);
await q(
  `update integrations set is_enabled = true, last_verified_at = now() where slug = 'youtube'`,
);

async function seedPublication({ title, decision = 'pass', renderStatus = 'ready', disclosed = true }) {
  const conceptId = randomUUID(), scriptId = randomUUID(), renderId = randomUUID();
  const reviewId = randomUUID(), pubId = randomUUID(), assetId = randomUUID();
  await q(`insert into concepts (id, channel_id, title, angle, rubric_version)
           values ($1,$2,$3,'a','v1')`, [conceptId, channelId, title]);
  await q(`insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash, human_edit_count)
           values ($1,$2,'h','[]'::jsonb,'w','claude-opus-5',$3,1)`, [scriptId, conceptId, randomUUID()]);
  await q(`insert into assets (id, kind, storage_key) values ($1,'video',$2)`,
          [assetId, `renders/${renderId}.mp4`]);
  await q(`insert into renders (id, script_id, variant_group_id, variant_label, format, width, height, status, asset_id)
           values ($1,$2,$3,'a','shorts_9x16',1080,1920,$4,$5)`,
          [renderId, scriptId, randomUUID(), renderStatus, assetId]);
  await q(`insert into reviews (id, render_id, reviewer_id, decision, human_edit_count, structure_novel)
           values ($1,$2,$3,$4,1,true)`, [reviewId, renderId, randomUUID(), decision]);
  await q(`insert into publications (id, render_id, channel_id, review_id, title, status, altered_content_disclosed)
           values ($1,$2,$3,$4,$5,'draft',$6)`,
          [pubId, renderId, channelId, reviewId, title, disclosed]);
  return { pubId, renderId, reviewId, scriptId };
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n1. Nothing published — the screen is empty, not broken\n');
{
  const board = await readPublishBoard(db);
  eq('no reads failed', board.unreadable.length, 0);
  eq('the queue is empty', board.queueTotal, 0);
  eq('and nothing is live', board.liveTotal, 0);
  // The quota window exists from migration 0035 even with no calls made — a countdown of
  // 10,000 remaining is a real answer, unlike every other vendor limit in this codebase.
  eq('a quota window exists', board.quota !== null, true);
  eq('with nothing used', board.quota.unitsUsed, 0);
  eq('and the ceiling is labelled as documented', board.quota.quotaSource, 'documented');
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n2. The queue reports the FIRST reason, earliest stage first\n');
const unreviewed = await seedPublication({ title: 'No pass', decision: 'reshoot' });
await seedPublication({ title: 'Not rendered', renderStatus: 'rendering' });
await seedPublication({ title: 'No disclosure', disclosed: false });
const ready = await seedPublication({ title: 'Ready to go' });
{
  const board = await readPublishBoard(db);
  eq('four in the queue', board.queueTotal, 4);
  const by = Object.fromEntries(board.rows.map((r) => [r.title, r.blocker]));
  eq('a failed review blocks first', by['No pass'], 'review_not_passed');
  eq('an unfinished render blocks next', by['Not rendered'], 'render_not_ready');
  eq('then the disclosure', by['No disclosure'], 'disclosure_not_set');
  // Null means nothing is stopping it. This is the assertion the whole screen rests on,
  // and §4 closes the loop by having the consumer agree.
  eq('and a ready one is not blocked', by['Ready to go'], null);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n3. LOAD-BEARING — the gate is the database, not the application\n');
// Why this is the load-bearing section. Every other readiness assertion here reads
// v_publish_queue, which is also what publishVideo reads — one source agreeing with itself,
// and green would mean only that. This asks the DATABASE independently, in SQL, past the
// application entirely. If it ever passes, enforce_review_pass has stopped being a gate and
// every other assertion in this file is describing a check with nothing behind it.
{
  for (const [label, status] of [['scheduled', 'scheduled'], ['uploading', 'uploading'], ['live', 'live']]) {
    try {
      await q(`update publications set status = $1 where id = $2`, [status, unreviewed.pubId]);
      bad(`the trigger refuses status='${label}' without a passing review`, 'it was allowed');
    } catch (err) {
      if (/blocked|review/i.test(err.message)) ok(`the trigger refuses status='${label}' without a passing review`);
      else bad(`the trigger refuses status='${label}' without a passing review`, err.message);
    }
  }
  // And the accepting branch, driven rather than assumed. A guard tested only on its
  // refusal passes on an empty database whatever the accept branch does.
  await q(`update publications set status = 'scheduled' where id = $1`, [ready.pubId]);
  ok('and allows it with one');
  await q(`update publications set status = 'draft' where id = $1`, [ready.pubId]);

  // There is no application-level bypass. Asserted by enumeration over src/, because
  // "there is no other place this happens" is a claim about the whole codebase and reading
  // one module cannot support it.
  //
  // The pattern names the SHAPE it is claiming about, and it took two corrections to say
  // that, both worth recording because both are this project's own failure modes committed
  // inside an assertion about them:
  //
  //   1. The bare word "bypass" matched `src/middleware.ts`, in a comment about a removed
  //      `ONBOARDING_GATE_BYPASS` env var. True, unrelated, a different gate — a guard
  //      measuring a broader quantity than the claim it supports.
  //   2. `(force|skip|bypass)[_ -]?(review|publish)` then matched **`enforce_review_pass`**
  //      — the name of the gate itself, in six files that exist to say it is not bypassed.
  //      A guard that fires on the thing it protects.
  //
  // `\b` is the fix and not a fudge: `force` inside `enforce` is not a word, and requiring
  // the boundary is what distinguishes "a flag called forceReview" from "the trigger named
  // enforce_review_pass". The right correction removed the false positives without
  // widening what passes — `forcePublish`, `skip_review` and `publish_bypass` all still hit.
  const { execSync } = await import('node:child_process');
  const bypass = execSync(
    `grep -rniE "\\b(force|skip|bypass)[_ -]?(review|publish)|\\b(review|publish)[_ -]?(force|skip|bypass)" src/ || true`,
    { encoding: 'utf8' },
  ).trim();
  eq('no force flag, skip-review or publish bypass anywhere in src/', bypass, '');

  // And the trigger itself is not disabled or dropped anywhere in the migrations — the
  // other way a gate stops being a gate, which no amount of grepping src/ would find.
  const { rows: trig } = await q(
    `select tgenabled from pg_trigger where tgname like '%review_pass%'`);
  eq('the gate trigger exists', trig.length > 0, true);
  eq('  · and is enabled', trig.every((t) => t.tgenabled === 'O'), true);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n4. A publish that works, and what it spends\n');
{
  vendor.mode = 'ok';
  const before = await readQuota(db, 'youtube');
  const result = await publishVideo(
    { publicationId: ready.pubId, idempotencyKey: `publish:${ready.pubId}` },
    { db, app, downloadRender, fetchImpl: stubFetch },
  );
  eq('the publish succeeded', result.ok, true);
  eq('and returned the vendor id', result.videoId, 'vid_stub_123');
  eq('every byte arrived', vendor.bytesReceived, 1024);

  const { rows } = await q(`select status, external_post_id, external_url, published_at,
                                   upload_session_url, upload_bytes_sent
                              from publications where id = $1`, [ready.pubId]);
  eq('the row is live', rows[0].status, 'live');
  eq('with the video id recorded', rows[0].external_post_id, 'vid_stub_123');
  // Cleared on success: an open session is only useful while it is unfinished, and leaving
  // it would make a later reader think an upload is in flight.
  eq('and the session url cleared', rows[0].upload_session_url, null);

  const after = await readQuota(db, 'youtube');
  eq('1,600 units were spent', after.window.unitsUsed - before.window.unitsUsed, 1600);
  eq('and none of them wasted', after.window.unitsWasted, 0);
  eq('the remaining figure moved with it', after.window.unitsRemaining, 10000 - 1600);

  // The disclosure, as it actually left the building. Asserted against the request body the
  // server received — not against `insertBody`'s return value, which §0 already covered.
  // Two routes to the same claim: one through the pure function, one through a real HTTP
  // request made by the code under test.
  const sent = JSON.parse(vendor.lastInsertBody);
  eq('the vendor received the disclosure', sent.status.containsSyntheticMedia, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n5. A replay does not put a second video on the channel\n');
{
  const again = await publishVideo(
    { publicationId: ready.pubId, idempotencyKey: `publish:${ready.pubId}` },
    { db, app, downloadRender, fetchImpl: stubFetch },
  );
  eq('the replay is refused', again.ok, false);
  eq('  · because it is already live', again.code, 'already_live');
  eq('and no further units were spent', (await readQuota(db, 'youtube')).window.unitsUsed, 1600);
  eq('the vendor was not called again', vendor.sessionsOpened, 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n6. Units are spent on failure too, and refused before the call\n');
const failing = await seedPublication({ title: 'Will fail' });
{
  vendor.mode = 'quota_exceeded';
  const before = await readQuota(db, 'youtube');
  const result = await publishVideo(
    { publicationId: failing.pubId, idempotencyKey: `publish:${failing.pubId}` },
    { db, app, downloadRender, fetchImpl: stubFetch },
  );
  eq('the publish failed', result.ok, false);
  eq('  · naming the quota', result.code, 'quota_exceeded');

  const after = await readQuota(db, 'youtube');
  // The assertion this section exists for. The vendor charges the attempt, so a ledger
  // that refunded on failure would report a comfortable remaining figure on the exact day
  // a retry loop emptied the window.
  eq('the units were still spent', after.window.unitsUsed - before.window.unitsUsed, 1600);
  eq('and are counted as wasted', after.window.unitsWasted, 1600);

  // A 403 is the only evidence that will ever exist for the real ceiling, so it is recorded
  // rather than treated as a generic failure.
  const { rows } = await q(`select quota_source from integrations where slug='youtube'`);
  eq('the ceiling became observable', rows[0].quota_source, 'observed');
  await q(`update integrations set quota_source='documented' where slug='youtube'`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n7. An upload that cannot fit is refused before it spends\n');
{
  // Burn the window down to under one upload. Written as usage rows rather than by
  // lowering the ceiling: the ceiling is the vendor's claim and the usage is ours, and
  // faking the vendor's half would test a world that cannot occur.
  await q(`insert into api_quota_usage (integration_id, endpoint, units, succeeded)
           select id, 'videos.insert', 7000, true from integrations where slug='youtube'`);
  const read = await readQuota(db, 'youtube');
  eq('under one upload remains', read.window.unitsRemaining < 1600, true);

  const blocked = await seedPublication({ title: 'No room today' });
  const board = await readPublishBoard(db);
  const row = board.rows.find((r) => r.title === 'No room today');
  // Producer and consumer, in both directions. The view says blocked...
  eq('the queue says the quota blocks it', row.blocker, 'insufficient_quota');

  const result = await publishVideo(
    { publicationId: blocked.pubId, idempotencyKey: `publish:${blocked.pubId}` },
    { db, app, downloadRender, fetchImpl: stubFetch },
  );
  // ...and the consumer refuses for the same reason. Either half alone is a source
  // agreeing with itself.
  eq('and the task refuses for the same reason', result.code, 'blocked_insufficient_quota');
  eq('spending nothing', result.unitsSpent, 0);

  await q(`delete from api_quota_usage where units = 7000`);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n8. A dead credential is not a network blip\n');
{
  vendor.mode = 'token_revoked';
  const dead = await checkTokenHealth(channelId, { db, app, fetchImpl: stubFetch });
  eq('the refresh failed', dead.ok, false);
  eq('  · as invalid_grant', dead.code, 'invalid_grant');
  // The distinction that decides what to do. Retrying an invalid_grant for a week while the
  // queue silently stops moving is the failure this flag prevents.
  eq('  · and it needs a human', dead.needsHuman, true);
  eq('one consecutive failure', dead.consecutiveFailures, 1);

  vendor.mode = 'token_network';
  const blip = await checkTokenHealth(channelId, { db, app, fetchImpl: stubFetch });
  eq('a 503 is a different code', blip.code, 'http_503');
  eq('  · and does NOT need a human', blip.needsHuman, false);
  eq('failures accumulate', blip.consecutiveFailures, 2);

  vendor.mode = 'ok';
  const healthy = await checkTokenHealth(channelId, { db, app, fetchImpl: stubFetch });
  eq('a success clears them', healthy.ok, true);
  eq('  · reporting what it recovered from', healthy.recoveredFrom, 2);
  const { rows } = await q(
    `select token_refresh_failures, token_refresh_error, token_last_refreshed_at
       from channels where id=$1`, [channelId]);
  eq('the counter reset', Number(rows[0].token_refresh_failures), 0);
  eq('the error cleared', rows[0].token_refresh_error, null);
  // "Last confirmed working" is a fact. There is deliberately no expiry column to assert.
  eq('and a confirmation timestamp was written', rows[0].token_last_refreshed_at !== null, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n9. The queue count comes from the database, not from the page\n');
{
  // One more than the page cap, so a screen deriving its total from `rows.length` would
  // under-report. This is the inverse test as an assertion rather than as a habit.
  const extra = QUEUE_PAGE + 1 - (await readPublishBoard(db)).queueTotal;
  for (let i = 0; i < extra; i += 1) {
    await seedPublication({ title: `Bulk ${i}`, decision: 'reshoot' });
  }
  const board = await readPublishBoard(db);
  eq('the page renders its cap', board.rows.length, QUEUE_PAGE);
  eq('and the count exceeds it', board.queueTotal, QUEUE_PAGE + 1);
  // The whole point: these two numbers differ, so the screen can say so. Equal would mean
  // the count was derived from the rows and the cap was invisible.
  eq('  · so the cap is visible rather than silent', board.queueTotal > board.rows.length, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n10. A broken read is not an empty queue\n');
{
  await q('drop view v_publish_queue cascade');
  const board = await readPublishBoard(db);
  eq('the failure is reported', board.unreadable.length > 0, true);
  eq('  · and the queue is not rendered as empty-and-fine',
     board.unreadable.some((u) => /v_publish_queue/.test(u)), true);
}

// ═══════════════════════════════════════════════════════════════════════════════
server.close();
await scratch.release();

console.log(`\n${failures === 0 ? 'Publishing is gated by the database and spends a quota it counts.' : `${failures} failure(s).`}\n`);
process.exit(failures === 0 ? 0 : 1);
