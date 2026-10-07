#!/usr/bin/env node
/**
 * verify:channels — two channels in one database, and the Instagram variant.
 *
 *   §1 Add channel: a slug with no bible folder is refused by name and writes nothing; a slug
 *      with one creates the row, policy, both publish targets and the cast — through
 *      `addChannel`, the function the form calls.
 *   §2 Isolation, screens: a brief, an episode and a cost row on channel B never appear in
 *      channel A's reads (the functions the Bureau pages and tools call), and do in B's.
 *   §3 Isolation, tools: an agent token for A asked about B's brief/episode/shot is refused; an
 *      approver token for A cannot approve B's brief (the database refuses it); A's resources
 *      answer with A's bible, B's with B's.
 *   §4 The Instagram variant: exact hashtags (3–5), the 2,200-character cap, the permalink
 *      parser.
 *   §5 The Instagram draft beside a YouTube bundle: refused for a channel without the target,
 *      made once for one with it, scheduled (not duplicated) by afterBundle's switched-off
 *      auto path; Mark posted refuses a bad link and another channel's token, then records the
 *      Reel live with its shortcode.
 *   §6 The Instagram probe, read-only: a personal account, an unlinked account, a wrong
 *      account and a good one, against a stub Graph API.
 *
 * Seeds inputs (channels, a reviewed render, briefs); asserts what the code under test wrote
 * or returned.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-channels.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { addChannel, setPublishTarget } = require(`${B}/channels/add.js`);
const { listChannels, pickActive, publishTargets } = require(`${B}/channels/list.js`);
const { BUREAU_CHANNEL_ID } = require(`${B}/fixtures/seed-channel.js`);
const { pendingBriefs, getBrief } = require(`${B}/bureau/briefs.js`);
const { episodeStatus, costsLedger, readyBundles } = require(`${B}/bureau/read.js`);
const { mintBureauToken } = require(`${B}/bureau/tokens.js`);
const { bureauSurface, loadTokenChannel, NO_EFFECTS } = require(`${B}/bureau/mcp/surface.js`);
const { buildInstagramVariant, instagramShortcode, CAPTION_MAX } = require(`${B}/publish/instagram-bundle.js`);
const { buildInstagramDraft, markInstagramPosted } = require(`${B}/bureau/instagram-draft.js`);
const { afterBundle } = require(`${B}/bureau/after-bundle.js`);
const { probeInstagram } = require(`${B}/publish/instagram.js`);
const { channelGeneration, episodeClips } = require(`${B}/bureau/overlay-only.js`);
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
const scratch = await scratchDatabase(dbUrl, 'channels');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
const A = BUREAU_CHANNEL_ID;
const call = async (surface, name, args) => {
  try {
    return await surface.callTool(name, args);
  } catch (err) {
    return { thrown: err.message };
  }
};

try {
  // ── §1 Add channel ─────────────────────────────────────────────────────────
  console.log('\n1. Add channel\n');
  const before = Number((await q('select count(*) from channels'))[0].count);
  const noFolder = await addChannel(db, { name: 'Ghost', slug: 'ghost-channel', targets: ['youtube'] });
  check(!noFolder.ok && /No bible folder channels\/ghost-channel\//.test(noFolder.refused) && /pnpm channel:new ghost-channel/.test(noFolder.refused), 'a slug without a folder is refused by name, with the command', noFolder.refused);
  check(Number((await q('select count(*) from channels'))[0].count) === before, 'and writes no channel row');
  const taken = await addChannel(db, { name: 'Again', slug: 'bureau-of-reality', targets: ['youtube'] });
  check(!taken.ok && /already belongs to channel "Bureau of Reality"/.test(taken.refused), 'a slug another channel holds is refused', taken.refused);

  // The only bible folder in the build is the Bureau's, which the seed channel holds. Free it
  // on A (A keeps every row; it just has no bible) so B can be added through the real path.
  await q('update channels set slug = null where id = $1', [A]);
  const added = await addChannel(db, {
    name: 'Second Desk',
    slug: 'bureau-of-reality',
    handle: 'seconddesk',
    youtube_channel_id: 'UCabcdefghijklmnopqrstuv',
    instagram_account_id: '17841400000000001',
    instagram_handle: 'second.desk',
    targets: ['youtube', 'instagram'],
  });
  check(added.ok, 'a slug with a folder is added', JSON.stringify(added));
  const CB = added.channelId;
  const [row] = await q('select name, slug, handle, platform, external_id from channels where id = $1', [CB]);
  check(row.slug === 'bureau-of-reality' && row.handle === '@seconddesk' && row.platform === 'youtube' && row.external_id === 'UCabcdefghijklmnopqrstuv', 'the row carries the slug, the normalised handle and the primary account', JSON.stringify(row));
  check((await q('select 1 from channel_policy where channel_id = $1', [CB])).length === 1, 'its policy row exists');
  const t = await publishTargets(db, CB);
  check(t.fromTable && JSON.stringify(t.targets.map((x) => [x.platform, x.externalId, x.handle])) === JSON.stringify([['instagram', '17841400000000001', '@second.desk'], ['youtube', 'UCabcdefghijklmnopqrstuv', '@seconddesk']]), 'both publish targets, each with its own account', JSON.stringify(t.targets));
  const castB = await q('select slug from characters where channel_id = $1 order by slug', [CB]);
  check(added.cast === 8 && castB.length === 8, 'the cast is synced onto B from its bible', `${added.cast} / ${castB.length}`);
  const all = await listChannels(db);
  check(pickActive(all, CB)?.id === CB && pickActive(all, 'not-a-channel')?.id === CB && pickActive(all, null)?.id === CB, 'the cookie picks B; a stale cookie and no cookie fall to the oldest channel WITH a bible (B, since A has none now)');

  // ── §2 Isolation, screens ─────────────────────────────────────────────────
  console.log('\n2. A brief, an episode and a cost row on B, read from A\n');
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 's@invalid.test', 88) returning id`);
  const briefSql = `insert into briefs (channel_id, slot_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, fact, titles, pinned_comment, status, created_by)
     values ($1, null, 'incident', 'pip', 'gravity', $2, 'x', 'y', 'z', 'bed_chalk_percussion', 'question', '["a","b","c"]', '[]', 'Pip: hi', '{"claim":"The Moon raises tides.","source_url":"https://oceanservice.noaa.gov/x"}', '[{"text":"Pip lost the Moon","hook_archetype":"question"},{"text":"Where did it go","hook_archetype":"warning"},{"text":"Tides on strike","hook_archetype":"number_claim"}]', 'Which desk next?', 'pending', 'agent') returning id`;
  const [briefA] = await q(briefSql, [A, 'Brief on A: Pip misplaces the Moon.']);
  const [briefB] = await q(briefSql, [CB, 'Brief on B: Pip loses the tide tables.']);
  const [conB] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 'B', 'b', 'v', 'in_production') returning id`, [CB]);
  const [scrB] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', 'hb') returning id`, [conB.id]);
  const [epB] = await q(`insert into episodes (brief_id, channel_id, script_id, status) values ($1, $2, $3, 'queued') returning id`, [briefB.id, CB, scrB.id]);
  await q(`insert into shots (script_id, idx, duration_s, description, render_route, character_slugs, status) values ($1, 0, 4, 'd', 'overlay', '{}', 'ready')`, [scrB.id]);
  await q(`insert into cost_ledger (channel_id, driver, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate) values ($1, 'x', 'estimate', 'x', 1, 0.5, 44, 88)`, [CB]);

  const pendA = await pendingBriefs(db, A);
  const pendB = await pendingBriefs(db, CB);
  check(pendA.map((b) => b.id).join() === briefA.id && pendB.map((b) => b.id).join() === briefB.id, 'pending briefs: each channel sees exactly its own', JSON.stringify({ a: pendA.length, b: pendB.length }));
  check((await getBrief(db, A, briefB.id)) === null && (await getBrief(db, CB, briefB.id))?.id === briefB.id, "B's brief is not readable as A's");
  check((await episodeStatus(db, A, epB.id)) === null && (await episodeStatus(db, CB, epB.id)) !== null, "B's episode is not readable as A's");
  const ledA = await costsLedger(db, A, '7d');
  const ledB = await costsLedger(db, CB, '7d');
  check(ledA.rows === 0 && ledA.total_inr === 0 && ledB.rows === 1 && ledB.total_inr === 44 && Number(ledB.recent[0].cost_inr) === 44, "B's ₹44 row is in B's ledger and not in A's", JSON.stringify({ a: [ledA.rows, ledA.total_inr], b: [ledB.rows, ledB.total_inr] }));

  // ── §3 Isolation, tools ───────────────────────────────────────────────────
  console.log('\n3. Tokens for A asked about B\n');
  const agentA = await mintBureauToken(db, { name: 'Routine A', scope: 'agent', channelId: A, profileId: null });
  const approverA = await mintBureauToken(db, { name: 'Sahil A', scope: 'approver', channelId: A, profileId: prof.id });
  const agentB = await mintBureauToken(db, { name: 'Routine B', scope: 'agent', channelId: CB, profileId: null });
  const tok = (m, scope, ch) => ({ id: m.id, scope, channelId: ch, profileId: scope === 'approver' ? prof.id : null, name: 'x' });
  const sA = bureauSurface({ db, token: tok(agentA, 'agent', A), effects: NO_EFFECTS, channel: await loadTokenChannel(db, A) });
  const sApA = bureauSurface({ db, token: tok(approverA, 'approver', A), effects: NO_EFFECTS, channel: await loadTokenChannel(db, A) });
  const sB = bureauSurface({ db, token: tok(agentB, 'agent', CB), effects: NO_EFFECTS, channel: await loadTokenChannel(db, CB) });

  const g = await call(sA, 'brief_get', { id: briefB.id });
  check(g.ok === false && /No such brief on this channel/.test(g.error), "agent A: brief_get on B's brief is refused", JSON.stringify(g));
  const e = await call(sA, 'episode_status', { id: epB.id });
  check(e.ok === false && /No such episode on this channel/.test(e.error), "agent A: episode_status on B's episode is refused", JSON.stringify(e));
  const r = await call(sA, 'shot_regenerate', { episode: epB.id, shot: 0, note: 'redo it' });
  check(/does not exist on this channel/.test(r.thrown ?? ''), "agent A: shot_regenerate on B's episode is refused", JSON.stringify(r));
  const pend = await call(sA, 'briefs_pending', {});
  check(pend.count === 1 && pend.briefs[0].id === briefA.id, 'agent A: briefs_pending lists A only', JSON.stringify(pend.briefs?.map((b) => b.id)));
  const appr = await call(sApA, 'brief_approve', { id: briefB.id, punchline: 'A' });
  check(/not_found|does not exist on this channel|No such brief/.test(appr.thrown ?? appr.error ?? ''), "approver A cannot approve B's brief", JSON.stringify(appr));
  check((await q('select status from briefs where id = $1', [briefB.id]))[0].status === 'pending', "and B's brief is still pending");
  const resA = await sA.resources.read('kiln://bible/characters');
  const resB = await sB.resources.read('kiln://bible/characters');
  check(JSON.parse(resA.text).refused === true && /has no slug/.test(JSON.parse(resA.text).summary), "A (no bible now) is refused its bible by name — never handed B's", resA.text.slice(0, 120));
  check(JSON.parse(resB.text).channel === 'bureau-of-reality', "B's token reads B's bible");
  const lintA = await call(sA, 'policy_lint', { script_text: 'Pip: hi.' });
  check(lintA.refused === true, 'policy_lint refuses on a channel without a bible rather than linting with another channel’s', JSON.stringify(lintA));
  check(sA.serverInfo.title === 'Kiln — Bureau of Reality' && sB.serverInfo.title === 'Kiln — Second Desk', 'each server names its token’s channel', `${sA.serverInfo.title} | ${sB.serverInfo.title}`);

  // ── §4 The Instagram variant ──────────────────────────────────────────────
  console.log('\n4. The Instagram variant\n');
  const base = {
    channelName: 'Second Desk',
    seriesName: 'Incident Report',
    title: 'Pip lost the Moon',
    premise: 'Pip misplaces the Moon and the tides file a complaint.',
    fact: { claim: 'The Moon raises the ocean tides.', source_url: 'https://oceanservice.noaa.gov/x' },
    hashtagPool: ['science', 'physics'],
    pinnedComment: 'Which desk next?',
    render: { width: 1080, height: 1920, durationS: 42 },
    coverFrameS: 2,
  };
  const v = buildInstagramVariant(base);
  check(JSON.stringify(v.hashtags) === JSON.stringify(['science', 'physics', 'IncidentReport', 'SecondDesk']), 'a 2-tag pool + series + channel → 4 hashtags', JSON.stringify(v.hashtags));
  check(v.caption === 'Pip lost the Moon\n\nPip misplaces the Moon and the tides file a complaint.\n\nThe real bit: The Moon raises the ocean tides.\nSource: https://oceanservice.noaa.gov/x\n\n#science #physics #IncidentReport #SecondDesk', 'the caption, exactly', JSON.stringify(v.caption));
  check(v.first_comment === 'Which desk next?\nSource: https://oceanservice.noaa.gov/x' && v.cover_frame_s === 2 && v.reels_api_problem === null, 'first comment, cover frame, and the file fits the Reels API');
  const many = buildInstagramVariant({ ...base, hashtagPool: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7'] });
  check(many.hashtags.length === 5 && many.hashtags.join() === 'a1,b2,c3,d4,e5', 'a long pool is cut to 5, never 30', many.hashtags.join());
  const one = buildInstagramVariant({ ...base, hashtagPool: [] });
  check(one.hashtags.length === 2, 'an empty pool yields the 2 derived tags — fewer than 3 is visible, not padded with junk', one.hashtags.join());
  const long = buildInstagramVariant({ ...base, premise: 'x'.repeat(5000) });
  check(long.caption.length === CAPTION_MAX && long.caption.endsWith('#science #physics #IncidentReport #SecondDesk') && long.caption.includes('Source: https://oceanservice.noaa.gov/x'), 'a 5,000-character premise is cut so the caption is exactly 2,200 with the fact and tags intact', String(long.caption.length));
  check(buildInstagramVariant({ ...base, render: { width: 1080, height: 1920, durationS: 95 } }).reels_api_problem === 'Reels via the API must be 5–90 s; this is 95 s.', 'a 95 s cut is flagged against the API limit');
  check(instagramShortcode('https://www.instagram.com/reel/C9xYz_12AB/?igsh=abc') === 'C9xYz_12AB' && instagramShortcode('https://instagram.com/p/AbCdE12/') === 'AbCdE12' && instagramShortcode('https://youtube.com/shorts/abc') === null, 'permalinks parse; anything else is null');

  // ── §5 The Instagram draft ────────────────────────────────────────────────
  console.log('\n5. The Instagram draft beside a YouTube bundle\n');
  const pubFor = async (ch, briefId, label) => {
    const [con] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 't', 'a', 'v', 'in_production') returning id`, [ch]);
    const [scr] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', $2) returning id`, [con.id, `h-${label}`]);
    const [ren] = await q(`insert into renders (script_id, variant_group_id, variant_label, format, width, height, status, duration_s) values ($1, gen_random_uuid(), 'composite', 'shorts_9x16', 1080, 1920, 'ready', 42) returning id`, [scr.id]);
    const [rev] = await q(`insert into reviews (render_id, reviewer_id, decision, structure_novel) values ($1, $2, 'pass', true) returning id`, [ren.id, prof.id]);
    const [ep] = await q(`insert into episodes (brief_id, channel_id, script_id, status, final_render_id, review_id) values ($1, $2, $3, 'bundled', $4, $5) returning id`, [briefId, ch, scr.id, ren.id, rev.id]);
    const bundle = { video_key: `renders/${label}.mp4`, files: { captions_srt: `srt/${label}.srt` }, slot_time: '2026-10-20T12:30:00.000Z' };
    const [pub] = await q(`insert into publications (render_id, channel_id, review_id, title, episode_id, bundle, altered_content_disclosed, platform) values ($1, $2, $3, 'Pip lost the Moon', $4, $5, false, 'youtube') returning id`, [ren.id, ch, rev.id, ep.id, JSON.stringify(bundle)]);
    return pub.id;
  };
  // A has no Instagram target once its 0046-seeded one is switched off.
  const badId = await setPublishTarget(db, A, { platform: 'instagram', enabled: true, external_id: 'not-digits' });
  check(!badId.ok && /account id is digits/.test(badId.refused), 'Channels: a malformed Instagram account id is refused', badId.refused);
  const off = await setPublishTarget(db, A, { platform: 'instagram', enabled: false });
  const [aIg] = await q(`select enabled from channel_publish_targets where channel_id = $1 and platform = 'instagram'`, [A]);
  check(off.ok && aIg.enabled === false, "Channels: A's 0046-seeded Instagram target switched off through setPublishTarget");
  const ytA = await pubFor(A, briefA.id, 'a');
  const refusedDraft = await buildInstagramDraft(db, ytA);
  check(!refusedDraft.ok && /Bureau of Reality has no enabled Instagram publish target/.test(refusedDraft.refused), 'a channel without the target is refused by name', refusedDraft.refused);
  check((await q(`select count(*) from publications where channel_id = $1 and platform = 'instagram'`, [A]))[0].count === '0', 'and no Reels row exists for A');

  const [briefB2] = await q(briefSql, [CB, 'Second brief on B: the tide tables return.']);
  const ytB = await pubFor(CB, briefB2.id, 'b');
  const covers = [];
  const d1 = await buildInstagramDraft(db, ytB, { coverStill: async (i) => { covers.push(i); return { ok: true, key: `publish/${i.publicationId}/instagram-cover.jpg` }; } });
  check(d1.ok && d1.created, 'a channel with the target gets a draft', JSON.stringify(d1));
  const [ig] = await q(`select platform, status, idempotency_key, bundle, tags, render_id, review_id from publications where id = $1`, [d1.publicationId]);
  const [yt] = await q('select render_id, review_id from publications where id = $1', [ytB]);
  check(ig.platform === 'instagram' && ig.status === 'draft' && ig.idempotency_key === `ig:${ytB}` && ig.render_id === yt.render_id && ig.review_id === yt.review_id, 'draft, same render and review, keyed on the YouTube row');
  check(covers.length === 1 && covers[0].videoKey === 'renders/b.mp4' && covers[0].atS === 2 && ig.bundle.files.cover_jpg === `publish/${ytB}/instagram-cover.jpg`, "the cover still is taken at the end of the series' cold open (2 s) and stored with the bundle", JSON.stringify(covers));
  check(ig.bundle.instagram_account === '@second.desk' && ig.bundle.video_key === 'renders/b.mp4' && JSON.stringify(ig.tags) === JSON.stringify(['science', 'physics', 'animation', 'explained', 'officecomedy']), 'the bundle names the account and posts the same MP4, with the first 5 of the bible’s pool', JSON.stringify(ig.tags));
  const d2 = await buildInstagramDraft(db, ytB);
  check(d2.ok && !d2.created && d2.publicationId === d1.publicationId, 'a second build returns the same draft');

  const ready = await readyBundles(db, CB, { presign: async (k) => `https://signed.invalid/${k}` });
  const igRow = ready.find((x) => x.platform === 'instagram');
  check(ready.filter((x) => x.episode_id === igRow?.episode_id).map((x) => x.platform).sort().join() === 'instagram,youtube' && igRow.download_urls.cover_jpg === `https://signed.invalid/publish/${ytB}/instagram-cover.jpg`, 'Ready to schedule reads both targets for the episode, with a signed cover link');

  // afterBundle's switched-off auto path, switched on: schedules the draft, inserts nothing.
  await q('update channel_policy set instagram_publish_enabled = true where channel_id = $1', [CB]);
  const ab = await afterBundle(db, ytB, { startUpload: async () => 'run' });
  const igRows = await q(`select status from publications where channel_id = $1 and platform = 'instagram'`, [CB]);
  check(/Reels mirror scheduled/.test(ab.instagram) && igRows.length === 1 && igRows[0].status === 'scheduled', 'with the flag on, afterBundle schedules the existing draft — one Reels row, not two', JSON.stringify({ ab, igRows }));
  await q(`update publications set status = 'draft', scheduled_for = null where id = $1`, [d1.publicationId]);
  await q('update channel_policy set instagram_publish_enabled = false where channel_id = $1', [CB]);

  const approverB = await mintBureauToken(db, { name: 'Sahil B', scope: 'approver', channelId: CB, profileId: prof.id });
  const tB = tok(approverB, 'approver', CB);
  const tA = tok(approverA, 'approver', A);
  const bad = await markInstagramPosted(db, tB, { publication_id: d1.publicationId, permalink: 'https://youtube.com/shorts/x', posted_at: new Date().toISOString() }).catch((err) => err.message);
  check(/not an Instagram Reel permalink/.test(bad), 'a non-Instagram link is refused', bad);
  const cross = await markInstagramPosted(db, tA, { publication_id: d1.publicationId, permalink: 'https://www.instagram.com/reel/C9xYz_12AB/', posted_at: new Date().toISOString() }).catch((err) => err.message);
  check(/No such publication on this channel/.test(cross), "an approver token for A cannot mark B's Reel", cross);
  const postedAt = '2026-10-07T10:00:00.000Z';
  const ok = await markInstagramPosted(db, tB, { publication_id: d1.publicationId, permalink: 'https://www.instagram.com/reel/C9xYz_12AB/', posted_at: postedAt });
  const [live] = await q('select status, external_post_id, external_url, published_at, marked_scheduled_at from publications where id = $1', [d1.publicationId]);
  check(ok.shortcode === 'C9xYz_12AB' && live.status === 'live' && live.external_post_id === 'C9xYz_12AB' && live.external_url === 'https://www.instagram.com/reel/C9xYz_12AB/' && live.published_at.toISOString() === postedAt && live.marked_scheduled_at !== null, 'Mark posted records the Reel live with its shortcode and permalink, through the decision function', JSON.stringify(live));
  const log = await q(`select action from authorship_log where subject_id = $1`, [d1.publicationId]);
  check(log.map((l) => l.action).join() === 'mark_scheduled', 'the authorship log carries the decision');
  const [ytStill] = await q('select status from publications where id = $1', [ytB]);
  check(ytStill.status === 'draft', 'the YouTube row is untouched by the Instagram post');

  // ── §6 The Instagram probe ────────────────────────────────────────────────
  console.log('\n6. The Instagram probe, against a stub Graph API\n');
  const graph = (routes) => async (url) => {
    const u = new URL(url);
    const key = u.pathname.split('/').pop();
    const r = routes[key] ?? { status: 404, body: { error: { message: 'not found' } } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  const personal = await probeInstagram('1784', 'tok', { fetchImpl: graph({ '1784': { status: 400, body: { error: { message: 'Unsupported get request' } } } }) });
  check(personal.length === 1 && !personal[0].passed && /personal account has no Graph API node/.test(personal[0].detail), 'a personal account fails credentials, with the fix', personal[0].detail);
  const unlinked = await probeInstagram('1784', 'tok', { fetchImpl: graph({ '1784': { status: 200, body: { id: '1784', username: 'desk' } }, accounts: { status: 200, body: { data: [{ name: 'Other', instagram_business_account: { id: '999' } }] } } }) });
  check(unlinked[0].passed && unlinked[0].detail === 'Account 1784 (@desk) read.' && !unlinked[1].passed && /not linked to any Facebook Page/.test(unlinked[1].detail), 'an account no visible Page links fails the channel check', unlinked[1].detail);
  const wrong = await probeInstagram('1784', 'tok', { expectedAccountId: '17841400000000001', fetchImpl: graph({ '1784': { status: 200, body: { id: '1784', username: 'desk' } }, accounts: { status: 200, body: { data: [{ name: 'Desk Page', instagram_business_account: { id: '1784' } }] } } }) });
  check(!wrong[1].passed && /active channel's Instagram target is 17841400000000001/.test(wrong[1].detail), "a token for another account than the channel's target fails", wrong[1].detail);
  const good = await probeInstagram('1784', 'tok', { expectedAccountId: '1784', fetchImpl: graph({ '1784': { status: 200, body: { id: '1784', username: 'desk' } }, accounts: { status: 200, body: { data: [{ name: 'Desk Page', instagram_business_account: { id: '1784' } }] } } }) });
  check(good.every((c) => c.passed) && good[1].detail === `@desk is linked to the Page "Desk Page" and is the active channel's target.`, 'a linked professional account that is the target passes both', good[1].detail);

  // ── §7 Overlay-only, said plainly ─────────────────────────────────────────
  console.log('\n7. Overlay-only cuts, and why\n');
  const r0 = await channelGeneration(db, CB);
  check(r0.summary === 'Every shot renders as an overlay: every cast reference frame is still a placeholder (pnpm frame:lock); no active recipe for character_beat or money_shot (Library → Prompts; activation needs a watched sample).', "B as committed: placeholders and two inactive recipes, in one sentence", r0.summary);
  await q(`update characters set external_ref_id = 'storage:characters/pip/ref-1.png', driver = 'runway' where channel_id = $1 and slug = 'pip'`, [CB]);
  const r1 = await channelGeneration(db, CB);
  check(r1.castWithoutFrames.length === 7 && !r1.castWithoutFrames.includes('pip') && /^Every shot renders as an overlay: .* have no locked reference frame; no active recipe/.test(r1.summary), 'one locked frame narrows the cast list, and the recipes still block every shot', r1.summary);
  const [conO] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 'o', 'o', 'v', 'in_production') returning id`, [CB]);
  const [scrO] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', 'ho') returning id`, [conO.id]);
  const [shotO] = await q(`insert into shots (script_id, idx, duration_s, description, render_route, character_slugs, status) values ($1, 0, 4, 'Pip waves', 'character_beat', '{pip}', 'ready') returning id`, [scrO.id]);
  await q(`insert into shots (script_id, idx, duration_s, description, render_route, character_slugs, status) values ($1, 1, 6, 'diagram', 'overlay', '{}', 'ready')`, [scrO.id]);
  const qcPlan = { plan: { swaps: [{ idx: 2, from: 'money_shot', reason: 'Incident Report does not allow a money shot' }] } };
  const e0 = await episodeClips(db, { script_id: scrO.id, qc: qcPlan });
  check(e0.generatedPlanned === 1 && e0.clips === 0 && e0.overlayOnly === true && e0.swaps.join() === 'shot 2: money_shot → overlay — Incident Report does not allow a money shot', 'a planned beat with no clip is overlay-only, with its swap verbatim', JSON.stringify(e0));
  const [genO] = await q(`insert into generations (kind, driver, model, request_payload, idempotency_key, status, shot_id) values ('video', 'x', 'm', '{}', 'k-o', 'succeeded', $1) returning id`, [shotO.id]);
  const e1 = await episodeClips(db, { script_id: scrO.id, qc: qcPlan });
  check(e1.clips === 0 && e1.overlayOnly, 'a succeeded generation without a normalised clip is still no clip — the assembler would draw the overlay');
  await q(`insert into assets (kind, storage_key, generation_id, normalized_at) values ('video', 'g/o.mp4', $1, now())`, [genO.id]);
  const e2 = await episodeClips(db, { script_id: scrO.id, qc: qcPlan });
  check(e2.clips === 1 && e2.overlayOnly === false, 'with a normalised clip the cut is not overlay-only', JSON.stringify(e2));
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await scratch.release();
}

console.log(failures ? `\n${failures} FAILED\n` : '\nTwo channels stay apart, and the Instagram variant holds.\n');
process.exit(failures ? 1 : 0);
