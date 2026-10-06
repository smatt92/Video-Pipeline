#!/usr/bin/env node
/**
 * verify:bureau-publish — what happens after the cut, behind the two flags, and the loop
 * that reads the results back.
 *
 *   §1 afterBundle with both flags false does nothing but say so (today's behaviour), and the
 *      publish queue blocks the Bureau publication with youtube_api_unaudited
 *   §2 with youtube_api_audited = true it schedules at the slot (both DB gates run) and starts
 *      the upload; the queue no longer blocks a disclosure decided false by the bundle —
 *      while a legacy publication with the same `false` is still blocked
 *   §3 with instagram_publish_enabled = true it creates the Reels mirror, scheduled
 *   §4 metrics at 1h/24h/72h/7d: due buckets only, an unreadable report is an `unavailable`
 *      row with the reason (never zeros), scheduled → live once past the slot; comments land
 *      with character mentions and complaint scores, idempotently
 *   §5 Studio CSV import fills viewed-vs-swiped on the latest snapshot, and reports what it
 *      could not match rather than writing 0
 *
 * Seeds the world (a reviewed render, an episode, a bundle); asserts what the code wrote.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-bureau-publish.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { afterBundle } = require(`${B}/bureau/after-bundle.js`);
const { pullBureauMetrics, dueBuckets } = require(`${B}/bureau/metrics-pull.js`);
const { importStudioCsv, parseStudioCsv } = require(`${B}/bureau/studio-csv.js`);
const { youtubeVideoId } = require(`${B}/publish/yt-analytics.js`);
const { dispatchProvider } = require(`${B}/bureau/dispatch.js`);
const { capAlerts, headroom } = require(`${B}/bureau/caps.js`);
const { BUREAU_CHANNEL_ID } = require(`${B}/bureau/bible.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const check = (c, l, d = '') => {
  if (c) console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
  else {
    console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
    failures++;
  }
};
const scratch = await scratchDatabase(dbUrl, 'bpublish');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;

console.log('\nBureau publishing and metrics\n');
try {
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 's@invalid.test', 88) returning id`);
  const [concept] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 't', 'a', 'v', 'in_production') returning id`, [BUREAU_CHANNEL_ID]);
  const [script] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', 'h') returning id`, [concept.id]);
  const [render] = await q(`insert into renders (script_id, variant_group_id, variant_label, format, width, height, status, duration_s) values ($1, gen_random_uuid(), 'composite', 'shorts_9x16', 1080, 1920, 'ready', 40) returning id`, [script.id]);
  const [review] = await q(`insert into reviews (render_id, reviewer_id, decision, structure_novel) values ($1, $2, 'pass', true) returning id`, [render.id, prof.id]);
  const [brief] = await q(`insert into briefs (channel_id, slot_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, fact, titles, pinned_comment, status, chosen_punchline, approved_at, created_by)
     values ($1, 'S001', 'incident', 'pip', 'gravity', 'Pip misplaces the Moon again.', 'x', 'y', 'z', 'w', 'question', '["a","b","c"]', '[]', 'Pip: hi', '{"claim":"c","source_url":"https://nasa.gov"}', '["a","b","c"]', 'p', 'approved', 'b', now(), 'agent') returning id`, [BUREAU_CHANNEL_ID]);
  const [ep] = await q(`insert into episodes (brief_id, channel_id, slot_id, script_id, status, final_render_id, review_id) values ($1, $2, 'S001', $3, 'bundled', $4, $5) returning id`, [brief.id, BUREAU_CHANNEL_ID, script.id, render.id, review.id]);
  const slot = '2026-10-19T12:30:00.000Z';
  const bundle = { video_key: 'renders/x.mp4', contains_synthetic_media: false, made_for_kids: false, slot_time: slot };
  const [pub] = await q(`insert into publications (render_id, channel_id, review_id, title, episode_id, slot_id, bundle, altered_content_disclosed, platform) values ($1, $2, $3, 'Pip lost the Moon', $4, 'S001', $5, false, 'youtube') returning id`, [render.id, BUREAU_CHANNEL_ID, review.id, ep.id, JSON.stringify(bundle)]);
  await q(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('youtube', 'channel', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);

  // §1
  console.log('1. Flags off (today)\n');
  const uploads = [];
  const deps = { startUpload: async (id) => { uploads.push(id); return 'run_upload'; } };
  const off = await afterBundle(db, pub.id, deps);
  const [p1] = await q('select status, scheduled_for from publications where id = $1', [pub.id]);
  check(/bundle only/.test(off.youtube) && /off/.test(off.instagram) && uploads.length === 0, 'nothing is uploaded and both paths say why', `${off.youtube} | ${off.instagram}`);
  check(p1.status === 'draft' && p1.scheduled_for === null, 'the publication is untouched');
  const [qb] = await q('select blocker from v_publish_queue where publication_id = $1', [pub.id]);
  check(qb.blocker === 'youtube_api_unaudited', 'the publish queue blocks it as unaudited', qb.blocker);

  // §2
  console.log('\n2. youtube_api_audited = true\n');
  await q('update channel_policy set youtube_api_audited = true where channel_id = $1', [BUREAU_CHANNEL_ID]);
  const [qa] = await q('select blocker from v_publish_queue where publication_id = $1', [pub.id]);
  check(qa.blocker === null || qa.blocker === 'insufficient_quota', 'a bundle-decided disclosure of false is not a blocker', String(qa.blocker));
  const [legacyPub] = await q(`insert into publications (render_id, channel_id, review_id, title, altered_content_disclosed) values ($1, $2, $3, 'legacy', false) returning id`, [render.id, BUREAU_CHANNEL_ID, review.id]);
  const [ql] = await q('select blocker from v_publish_queue where publication_id = $1', [legacyPub.id]);
  check(ql.blocker === 'disclosure_not_set', 'a legacy publication with false is still blocked', ql.blocker);
  await q('delete from publications where id = $1', [legacyPub.id]);
  const on = await afterBundle(db, pub.id, deps);
  const [p2] = await q('select status, scheduled_for from publications where id = $1', [pub.id]);
  check(p2.status === 'scheduled' && new Date(p2.scheduled_for).toISOString() === slot && uploads[0] === pub.id, 'scheduled at the slot and the upload started', on.youtube);

  // §3
  console.log('\n3. instagram_publish_enabled = true\n');
  await q(`update publications set status = 'draft', scheduled_for = null where id = $1`, [pub.id]);
  await q('update channel_policy set youtube_api_audited = false, instagram_publish_enabled = true where channel_id = $1', [BUREAU_CHANNEL_ID]);
  const ig = await afterBundle(db, pub.id, deps);
  const igRows = await q(`select status, scheduled_for from publications where platform = 'instagram' and episode_id = $1`, [ep.id]);
  check(igRows.length === 1 && igRows[0].status === 'scheduled', 'a Reels mirror is scheduled at the same slot', ig.instagram);
  await q(`update channel_policy set kill_switch = true, kill_switch_at = now(), kill_switch_reason = 'x' where channel_id = $1`, [BUREAU_CHANNEL_ID]);
  await q(`delete from publications where platform = 'instagram'`);
  const killed = await afterBundle(db, pub.id, deps);
  check(/refused/.test(killed.instagram), 'with the kill switch on, the mirror is refused by the database', killed.instagram);
  await q(`update channel_policy set kill_switch = false, kill_switch_at = null, kill_switch_reason = null, instagram_publish_enabled = false where channel_id = $1`, [BUREAU_CHANNEL_ID]);

  // §4
  console.log('\n4. Metrics and comments\n');
  check(youtubeVideoId('https://youtube.com/shorts/AbCdEfGhIj1?feature=share') === 'AbCdEfGhIj1' && youtubeVideoId('https://youtu.be/AbCdEfGhIj1') === 'AbCdEfGhIj1' && youtubeVideoId('nope') === null, 'a Shorts URL, a youtu.be link and an id all resolve; junk does not');
  const base = new Date('2026-10-19T12:30:00Z');
  check(JSON.stringify(dueBuckets(base, new Date('2026-10-20T13:00:00Z'), [])) === '["1h","24h"]', '24.5 h after the slot, 1h and 24h are due');
  check(JSON.stringify(dueBuckets(base, new Date('2026-10-20T13:00:00Z'), ['1h'])) === '["24h"]', 'a captured bucket is not pulled twice');
  await q(`update publications set status = 'scheduled', scheduled_for = $2, external_post_id = 'AbCdEfGhIj1' where id = $1`, [pub.id, slot]);
  let calls = 0;
  const mdeps = {
    db,
    now: () => new Date('2026-10-22T13:00:00Z'),
    analytics: async () => {
      calls++;
      return calls === 3 ? { ok: false, code: 'forbidden', detail: 'scope yt-analytics.readonly missing' } : { ok: true, metrics: { views: 1200 * calls, engagedViews: 900 * calls, averageViewPercentage: 71.5, subscribersGained: 2 }, raw: {} };
    },
    comments: async () => ({ ok: true, comments: [
      { externalId: 'c1', author: '@moonfan', body: 'Why does the Moon get to leave whenever it wants? Mrs Iyer would never allow this.', likes: 40, replies: 1, publishedAt: '2026-10-20T10:00:00Z', isPublic: true },
      { externalId: 'c2', author: '@x', body: 'lol', likes: 0, replies: 0, publishedAt: '2026-10-20T11:00:00Z', isPublic: true },
    ] }),
  };
  const m1 = await pullBureauMetrics(mdeps);
  const snaps = await q('select age_bucket, status, views, avg_view_pct, unavailable_reason from metrics_snapshots where publication_id = $1 order by captured_at', [pub.id]);
  check(m1.snapshots === 2 && m1.unavailable === 1 && snaps.length === 3, '72 h after the slot: three buckets due, two measured', JSON.stringify(m1));
  const failed = snaps.find((s) => s.status === 'unavailable');
  check(failed && failed.views === null && /yt-analytics/.test(failed.unavailable_reason), 'the failed pull is a row with its reason and no zeros');
  const [live] = await q('select status from publications where id = $1', [pub.id]);
  check(live.status === 'live', 'past its slot, the publication is live');
  const cm = await q(`select external_id, character_mentions, complaint_score from comments where publication_id = $1 order by external_id`, [pub.id]);
  check(cm.length === 2 && cm[0].character_mentions.join() === 'iyer' && Number(cm[0].complaint_score) > Number(cm[1].complaint_score), 'comments land with mentions and a complaint ranking', JSON.stringify(cm.map((c) => [c.external_id, c.character_mentions, c.complaint_score])));
  const m2 = await pullBureauMetrics(mdeps);
  const cm2 = await q('select count(*)::int n from comments where publication_id = $1', [pub.id]);
  check(m2.snapshots === 0 && cm2[0].n === 2, 'a second run pulls no bucket twice and duplicates no comment');

  // §5
  console.log('\n5. Studio CSV\n');
  const csv = 'Content,Video title,Views,Viewed vs. swiped away (%)\nAbCdEfGhIj1,Pip lost the Moon,"3,600",74.2\nZZZZZZZZZZZ,Not ours,10,50\nTotal,,3610,74.1\n';
  const parsed = parseStudioCsv(csv);
  check(parsed.rows.length === 2 && parsed.rows[0].views === 3600 && parsed.rows[0].viewedPct === 74.2, 'the CSV parses, thousands separators and the Total row handled');
  const imp = await importStudioCsv(db, BUREAU_CHANNEL_ID, csv);
  const [latest] = await q(`select viewed_vs_swiped_pct from metrics_snapshots where publication_id = $1 and status = 'measured' order by captured_at desc limit 1`, [pub.id]);
  check(imp.updated === 1 && Number(latest.viewed_vs_swiped_pct) === 74.2, 'viewed-vs-swiped lands on the latest measured snapshot');
  check(imp.unmatched.join() === 'ZZZZZZZZZZZ', 'a video that is not ours is reported, not written');
  check(parseStudioCsv('Video,Views\nA,1').problems.length === 1, 'a CSV without the percentage column is refused by name');

  // §6
  console.log('\n6. Daily cap, asserted at the dispatcher\n');
  await q(`update channel_policy set daily_cap_inr = 50 where channel_id = $1`, [BUREAU_CHANNEL_ID]);
  await q(`insert into cost_ledger (channel_id, driver, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate) values ($1, 'x', 'estimate', 'x', 1, 0.5, 44, 88)`, [BUREAU_CHANNEL_ID]);
  await q(`insert into gen_jobs (episode_id, render_route, provider, model, params, duration_s, estimate_inr, idempotency_key) values ($1, 'character_beat', 'fal', 'm', '{}', 4, 10, 'cap-test')`, [ep.id]);
  const subs = [];
  const d = await dispatchProvider('fal', 5, { db, worker: 'v', usdInrRate: 88, credentialsFor: async () => ({ ok: true, values: { FAL_KEY: 'x' } }), submit: async (i) => { subs.push(i); return { ok: true, requestId: 'r', pollRef: {} }; }, poll: async () => ({ state: 'running', vendorState: 'x' }), ingest: async () => ({ ok: false, code: 'x', detail: 'x' }), now: () => new Date('2026-10-22T10:00:00Z') });
  const [job] = await q(`select status, attempts, last_error_code, next_attempt_at from gen_jobs where idempotency_key = 'cap-test'`);
  check(d.deferred === 1 && subs.length === 0, 'a ₹10 job with ₹6 of daily headroom is not submitted', JSON.stringify(d));
  check(job.status === 'throttled' && job.attempts === 0 && job.last_error_code === 'cap', 'it waits as throttled, its attempt returned', JSON.stringify(job));
  const h = await headroom(db, BUREAU_CHANNEL_ID);
  check(capAlerts(h, new Date()).some((a) => a.key.startsWith('cap80:day:')), 'and the 80% daily alert fires', JSON.stringify(capAlerts(h, new Date())));
} catch (err) {
  check(false, 'harness threw', err.stack);
} finally {
  await scratch.release();
}
console.log(failures ? `\n${failures} FAILED\n` : '\nBureau publishing and metrics hold.\n');
process.exit(failures ? 1 : 0);
