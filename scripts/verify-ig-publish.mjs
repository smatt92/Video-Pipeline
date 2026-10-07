#!/usr/bin/env node
/**
 * verify:ig-publish — Instagram Reels publishing to an account we own (decision 0023),
 * against a STUB Graph API. Never the real one: nothing here can post.
 *
 *   §1 Refusals before anything moves: an agent token; the channel flag off; the integration
 *      unverified; the target disabled. No row changes and no Graph call is made.
 *   §2 The database gate: a Reel whose cut review is not a pass cannot be scheduled
 *      (enforce_review_pass via bureau_mark_scheduled), whatever the code above it does.
 *   §3 Publish now: scheduled through the decision function (authorship log), the post run
 *      started, then container → IN_PROGRESS → FINISHED → media_publish → permalink stored in
 *      the Mark-posted fields. The container carries REELS, the presigned video and cover,
 *      the caption, share_to_feed. The status checks wait once a minute (Meta's guidance).
 *   §4 Never twice: a replay of a live Reel, and a replay after media_publish was called but
 *      its answer never recorded, both refuse without calling media_publish; two runs racing
 *      one scheduled row post it once.
 *   §5 An ERROR container is a failed row carrying Meta's message; Publish again re-schedules
 *      it through the gate and a fresh container is made.
 *
 * Seeds inputs (a channel target, a reviewed render, the Reels draft, a verified integration
 * row); asserts what publishReel / requestInstagramPublish wrote and what the stub received.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-ig-publish.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { BUREAU_CHANNEL_ID: A } = require(`${B}/fixtures/seed-channel.js`);
const { setPublishTarget } = require(`${B}/channels/add.js`);
const { mintBureauToken } = require(`${B}/bureau/tokens.js`);
const { buildInstagramDraft, requestInstagramPublish } = require(`${B}/bureau/instagram-draft.js`);
const { publishReel, CONTAINER_CHECKS_S } = require(`${B}/publish/ig-run.js`);
const { setCaps } = require(`${B}/bureau/control.js`);
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
const scratch = await scratchDatabase(dbUrl, 'igpublish');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
const thrown = async (p) => p.then(() => null, (err) => err.message);

// ── The stub Graph API ──────────────────────────────────────────────────────
const IG = '17841400000000042';
function graphStub(opts = {}) {
  const calls = [];
  let statusN = 0;
  const statuses = opts.statuses ?? ['IN_PROGRESS', 'FINISHED'];
  let containers = 0;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ method, path: u.pathname, search: u.search, body, auth: init.headers?.authorization });
    const last = u.pathname.split('/').pop();
    if (last === 'content_publishing_limit') return json(200, { data: [{ quota_usage: opts.used ?? 3, config: { quota_total: 100, quota_duration: 86400 } }] });
    if (last === 'media' && method === 'POST') return json(200, { id: `cont_${++containers}` });
    if (last.startsWith('cont_')) {
      const s = statuses[Math.min(statusN++, statuses.length - 1)];
      return json(200, s === 'ERROR' ? { status_code: 'ERROR', status: 'Error: The video codec is not supported (2207026)' } : { status_code: s });
    }
    if (last === 'media_publish') return json(200, { id: '18000000000000777' });
    if (last === '18000000000000777') return json(200, { id: '18000000000000777', permalink: 'https://www.instagram.com/reel/DKiln_77xY/', shortcode: 'DKiln_77xY' });
    return json(404, { error: { message: 'stub: no route' } });
  };
  return { calls, fetchImpl, publishes: () => calls.filter((c) => c.path.endsWith('/media_publish')).length };
}
const deps = (sleeps = []) => ({
  presign: async (key, ttl) => `https://bucket.invalid/${key}?X-Amz-Expires=${ttl}`,
  // As the task does: the render's own asset key and its measured facts (numeric → Number).
  render: async (renderId) => {
    const [r] = (await client.query('select r.width, r.height, r.duration_s, a.storage_key from renders r join assets a on a.id = r.asset_id where r.id = $1', [renderId])).rows;
    return { key: r.storage_key, width: r.width, height: r.height, durationS: r.duration_s === null ? null : Number(r.duration_s) };
  },
  sleep: async (s) => { sleeps.push(s); },
});

try {
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'sahil@invalid.test', 88) returning id`);
  const approverRow = await mintBureauToken(db, { name: 'Sahil', scope: 'approver', channelId: A, profileId: prof.id });
  const agentRow = await mintBureauToken(db, { name: 'Routine', scope: 'agent', channelId: A, profileId: null });
  const approver = { id: approverRow.id, name: 'Sahil', scope: 'approver', channelId: A, profileId: prof.id };
  const agent = { id: agentRow.id, name: 'Routine', scope: 'agent', channelId: A, profileId: null };
  // Five Reels go live here; the channel's daily publish cap (an input) allows them.
  await q('update channel_policy set daily_publish_cap = 10 where channel_id = $1', [A]);
  const target = await setPublishTarget(db, A, { platform: 'instagram', enabled: true, external_id: IG, handle: '@bureau' });
  check(target.ok, 'the channel has an Instagram target naming its own account', target.ok ? '' : target.refused);

  // A reviewed render, its YouTube bundle and the Reels draft — the draft through the code.
  const reels = async (label, decision = 'pass') => {
    const [con] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 't', 'a', 'v', 'in_production') returning id`, [A]);
    const [scr] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', $2) returning id`, [con.id, `ig-${label}`]);
    const [asset] = await q(`insert into assets (kind, storage_key) values ('video', $1) returning id`, [`renders/${label}.mp4`]);
    const [ren] = await q(`insert into renders (script_id, variant_group_id, variant_label, format, width, height, status, duration_s, asset_id) values ($1, gen_random_uuid(), 'composite', 'shorts_9x16', 1080, 1920, 'ready', 42, $2) returning id`, [scr.id, asset.id]);
    const [rev] = await q(`insert into reviews (render_id, reviewer_id, decision, structure_novel) values ($1, $2, $3, true) returning id`, [ren.id, prof.id, decision]);
    const [brief] = await q(`insert into briefs (channel_id, slot_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, fact, titles, pinned_comment, status, created_by)
      values ($1, null, 'incident', 'pip', 'gravity', $2, 'x', 'y', 'z', 'bed_chalk_percussion', 'question', '["a","b","c"]', '[]', 'Pip: hi', '{"claim":"The Moon raises tides.","source_url":"https://oceanservice.noaa.gov/x"}', '[{"text":"Pip lost the Moon","hook_archetype":"question"},{"text":"Where did it go","hook_archetype":"warning"},{"text":"Tides on strike","hook_archetype":"number_claim"}]', 'Which desk next?', 'pending', 'agent') returning id`, [A, `Pip misplaces the Moon (${label}).`]);
    const [ep] = await q(`insert into episodes (brief_id, channel_id, script_id, status, final_render_id, review_id) values ($1, $2, $3, 'bundled', $4, $5) returning id`, [brief.id, A, scr.id, ren.id, rev.id]);
    const bundle = { video_key: `renders/${label}.mp4`, files: {}, slot_time: '2099-01-01T12:30:00.000Z' };
    const [yt] = await q(`insert into publications (render_id, channel_id, review_id, title, episode_id, bundle, altered_content_disclosed, platform) values ($1, $2, $3, 'Pip lost the Moon', $4, $5, false, 'youtube') returning id`, [ren.id, A, rev.id, ep.id, JSON.stringify(bundle)]);
    const d = await buildInstagramDraft(db, yt.id, { coverStill: async (i) => ({ ok: true, key: `publish/${i.publicationId}/instagram-cover.jpg` }) });
    if (!d.ok) throw new Error(`draft: ${d.refused}`);
    return d.publicationId;
  };
  const statusOf = async (id) => (await q('select status, bundle, external_url, external_post_id, error_detail, scheduled_for from publications where id = $1', [id]))[0];
  const started = [];
  const effects = { async startInstagramPost(id, attempt) { started.push({ id, attempt }); return `run_ig_${started.length}`; } };

  // ── §1 Refusals ────────────────────────────────────────────────────────────
  console.log('\n1. Refused before anything moves\n');
  const p1 = await reels('one');
  const byAgent = await thrown(requestInstagramPublish(db, agent, effects, { publication_id: p1, when: 'now' }));
  check(/needs the approver scope/.test(byAgent ?? ''), 'an agent token cannot publish', byAgent);
  await q('update channel_policy set instagram_publish_enabled = false where channel_id = $1', [A]);
  const flagOff = await thrown(requestInstagramPublish(db, approver, effects, { publication_id: p1, when: 'now' }));
  check(/Instagram publishing is off for this channel/.test(flagOff ?? ''), 'with instagram_publish_enabled off, refused by name', flagOff);
  // The switch's one write path (0050): caps_set, approver only, logged.
  const agentFlip = await thrown(setCaps(db, agent, { instagram_publish_enabled: true }));
  const flip = await setCaps(db, approver, { instagram_publish_enabled: true });
  const [flipLog] = await q(`select payload from authorship_log where action = 'caps_set' and channel_id = $1 order by occurred_at desc limit 1`, [A]);
  check(/approver scope/.test(agentFlip ?? '') && flip.policy.instagram_publish_enabled === true && flipLog?.payload.instagram_publish_enabled === true, 'caps_set turns Instagram publishing on (approver only, logged); an agent cannot', agentFlip);
  await q(`delete from integrations where slug = 'instagram'`);
  const unverified = await thrown(requestInstagramPublish(db, approver, effects, { publication_id: p1, when: 'now' }));
  check(/Instagram integration cannot be used/.test(unverified ?? ''), 'with the integration never verified, refused by name', unverified);
  await q(`insert into integrations (slug, kind, is_enabled, last_checked_at, last_verified_at) values ('instagram', 'channel', true, now(), now())`);
  await setPublishTarget(db, A, { platform: 'instagram', enabled: false });
  const noTarget = await thrown(requestInstagramPublish(db, approver, effects, { publication_id: p1, when: 'now' }));
  check(/not an enabled publish target/.test(noTarget ?? ''), 'with the target disabled, refused by name', noTarget);
  await setPublishTarget(db, A, { platform: 'instagram', enabled: true, external_id: IG, handle: '@bureau' });
  const s1 = await statusOf(p1);
  check(s1.status === 'draft' && started.length === 0, 'after four refusals the Reel is still a draft and no post run started', s1.status);
  const g0 = graphStub();
  const notSched = await publishReel(db, p1, { igUserId: IG, accessToken: 'tok', fetchImpl: g0.fetchImpl }, deps());
  check(!notSched.ok && notSched.code === 'not_scheduled' && g0.calls.length === 0, 'publishReel refuses a draft that never went through the gate, with no Graph call', notSched.detail);

  // ── §2 The database gate ──────────────────────────────────────────────────
  console.log('\n2. The cut was not approved\n');
  const pBad = await reels('reshoot', 'reshoot');
  const gate = await thrown(requestInstagramPublish(db, approver, effects, { publication_id: pBad, when: 'now' }));
  const direct = await thrown(q(`update publications set status = 'scheduled', scheduled_for = now() where id = $1`, [pBad]));
  check(gate !== null && direct !== null && (await statusOf(pBad)).status === 'draft' && started.length === 0, 'LOAD-BEARING: a Reel whose review is not a pass cannot be scheduled — refused by the database through the decision function AND on a direct update', `${gate} | ${direct}`);

  // ── §3 Publish now ────────────────────────────────────────────────────────
  console.log('\n3. Publish now\n');
  const req = await requestInstagramPublish(db, approver, effects, { publication_id: p1, when: 'now' });
  const sched = await statusOf(p1);
  const [logRow] = await q(`select action, payload from authorship_log where subject_id = $1`, [p1]);
  check(req.ok && sched.status === 'scheduled' && started.at(-1)?.id === p1 && logRow?.action === 'mark_scheduled' && logRow.payload.platform === 'instagram', 'scheduled through bureau_mark_scheduled (logged) and the post run started', JSON.stringify({ status: sched.status, started }));
  const g = graphStub({ statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] });
  const sleeps = [];
  const out = await publishReel(db, p1, { igUserId: IG, accessToken: 'tok', fetchImpl: g.fetchImpl }, deps(sleeps));
  const live = await statusOf(p1);
  check(out.ok && live.status === 'live' && live.external_url === 'https://www.instagram.com/reel/DKiln_77xY/' && live.external_post_id === 'DKiln_77xY' && live.bundle.publish.media_id === '18000000000000777',
    'container → FINISHED → publish → permalink: live, permalink and shortcode in the Mark-posted fields, the media id kept', JSON.stringify({ status: live.status, url: live.external_url, id: live.external_post_id }));
  const create = g.calls.find((c) => c.method === 'POST' && c.path.endsWith(`/${IG}/media`));
  check(create?.body.media_type === 'REELS' && create.body.share_to_feed === 'true' && create.body.video_url === 'https://bucket.invalid/renders/one.mp4?X-Amz-Expires=10800' && /instagram-cover\.jpg\?X-Amz-Expires=10800$/.test(create.body.cover_url ?? '') && create.body.caption === live.bundle.caption && create.auth === 'Bearer tok',
    'the container is a REELS one with the presigned MP4 and cover (3 h), the bundle’s caption and share_to_feed', JSON.stringify(create?.body).slice(0, 200));
  check(JSON.stringify(sleeps) === JSON.stringify([60, 60]) && CONTAINER_CHECKS_S.length === 5, 'two IN_PROGRESS answers → two one-minute waits (Meta: once a minute, at most five minutes)', JSON.stringify(sleeps));
  const order = g.calls.map((c) => c.path.split('/').pop());
  check(order[0] === 'content_publishing_limit' && order.indexOf('media_publish') > order.lastIndexOf('cont_1') && g.publishes() === 1 && g.calls.every((c) => c.path.startsWith('/v25.0/')), 'limit read first, publish only after FINISHED, exactly one media_publish, all on v25.0', order.join(' → '));

  // ── §4 Never twice ────────────────────────────────────────────────────────
  console.log('\n4. A retry does not publish twice\n');
  const again = await publishReel(db, p1, { igUserId: IG, accessToken: 'tok', fetchImpl: g.fetchImpl }, deps());
  const againReq = await thrown(requestInstagramPublish(db, approver, effects, { publication_id: p1, when: 'now' }));
  check(!again.ok && again.code === 'already_live' && g.publishes() === 1 && againReq !== null, 'a replay of a live Reel refuses, and Publish now refuses it too; media_publish still called once', `${again.detail} | ${againReq}`);
  const p2 = await reels('two');
  await requestInstagramPublish(db, approver, effects, { publication_id: p2, when: 'now' });
  // The state a run leaves when it died between media_publish and recording its answer.
  const b2 = (await statusOf(p2)).bundle;
  await q('update publications set bundle = $2 where id = $1', [p2, JSON.stringify({ ...b2, publish: { container_id: 'cont_9', publishing_at: '2026-10-07T10:00:00Z' } })]);
  const g2 = graphStub({ statuses: ['FINISHED'] });
  const maybe = await publishReel(db, p2, { igUserId: IG, accessToken: 'tok', fetchImpl: g2.fetchImpl }, deps());
  check(!maybe.ok && maybe.code === 'maybe_published' && g2.calls.length === 0 && (await statusOf(p2)).status === 'scheduled', 'after an unrecorded media_publish, a retry refuses with no Graph call — reconcile by Mark posted', maybe.detail);
  const p3 = await reels('three');
  await requestInstagramPublish(db, approver, effects, { publication_id: p3, when: 'now' });
  const g3 = graphStub({ statuses: ['FINISHED'] });
  const race = await Promise.all([1, 2].map(() => publishReel(db, p3, { igUserId: IG, accessToken: 'tok', fetchImpl: g3.fetchImpl }, deps())));
  check(race.filter((r) => r.ok).length === 1 && race.some((r) => !r.ok && r.code === 'claimed') && g3.publishes() === 1, 'two runs racing one scheduled Reel: one claims it, one posts', race.map((r) => (r.ok ? 'posted' : r.code)).join(', '));

  // ── §5 ERROR container ────────────────────────────────────────────────────
  console.log('\n5. Meta cannot process the video\n');
  const p4 = await reels('four');
  await requestInstagramPublish(db, approver, effects, { publication_id: p4, when: 'now' });
  const g4 = graphStub({ statuses: ['ERROR'] });
  const err = await publishReel(db, p4, { igUserId: IG, accessToken: 'tok', fetchImpl: g4.fetchImpl }, deps());
  const failed = await statusOf(p4);
  check(!err.ok && failed.status === 'failed' && /codec is not supported \(2207026\)/.test(failed.error_detail) && g4.publishes() === 0, 'an ERROR container fails the row with Meta’s own message, and nothing is published', failed.error_detail);
  const retry = await requestInstagramPublish(db, approver, effects, { publication_id: p4, when: 'now' });
  const g5 = graphStub({ statuses: ['FINISHED'] });
  const ok4 = await publishReel(db, p4, { igUserId: IG, accessToken: 'tok', fetchImpl: g5.fetchImpl }, deps());
  check(retry.ok && ok4.ok && g5.calls.some((c) => c.method === 'POST' && c.path.endsWith('/media')) && (await statusOf(p4)).status === 'live', 'Publish again re-schedules it through the gate; a fresh container is made and it posts', JSON.stringify(ok4));
  const slot = await requestInstagramPublish(db, approver, effects, { publication_id: await reels('five'), when: 'slot' });
  check(slot.ok && slot.at === '2099-01-01T12:30:00.000Z' && slot.run_id === null, '"At the slot" schedules at the bundle’s slot and starts nothing now (the 15-minute cron posts it when due)', JSON.stringify(slot));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await scratch.release();
}

console.log(failures ? `\n${failures} FAILED\n` : '\nReels post once, to our own account, behind the review gate.\n');
process.exit(failures ? 1 : 0);
