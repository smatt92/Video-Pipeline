#!/usr/bin/env node
/**
 * Stage 1 — trend intake, against real Postgres and stub HTTP feeds.
 *
 * PROVES:  signals land with their raw payload kept and their channel_id; the velocity proxy
 *          is computed from the inputs rather than copied (Reddit score/hour, YouTube
 *          views/hour); the same term twice in a day updates rather than duplicating, per
 *          channel, and keeps the *later* reading; a malformed listing is skipped without
 *          failing the run; a source that is down does not take the others with it; Google
 *          Trends turned off says so; a missing YouTube key refuses by naming
 *          YOUTUBE_DATA_API_KEY and makes no request; quota exhaustion is reported by name;
 *          channel B's run writes nothing under channel A; the scheduled path runs every
 *          channel with a bible and skips the rest by name; Run now (`startTrendsRun`) refuses
 *          by name anyone who is not the approver (no session / not allow-listed / no profiles
 *          row), a channel with no bible and a trends.json with no sources — none of which
 *          reach trigger — and otherwise hands the task exactly the channel's id and its
 *          trends.json (read here from disk, not from the bible module) and returns the
 *          handle id; `trends_recent` answers for the token's channel only and refuses another
 *          by slug or id; a database without 0046's column still collects, and trends_recent
 *          falls back to unfiltered, both saying so; and no
 *          `cost_ledger` row is written, because nothing here costs money.
 *
 * DOES NOT: prove the real feeds return this shape. Reddit's listing is public and
 *           unversioned, and the Data API stubs here are written from its documentation — a
 *           real call with a real key is what closes that (rule 8).
 *
 * Usage: node scripts/verify-trends.mjs <db-url>
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert/strict';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-trends.mjs <db-url>');
  process.exit(2);
}

// ── The stub Reddit Data API (token + listings on one host) ─────────────────
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
let listing = null;
let hits = 0;
/** 'ok' | 'forbidden' (every listing 403, as unauthenticated reads are since 28-May-2026) | 'badcreds' (token 401). */
let redditMode = 'ok';
const redditRequests = [];

const feed = createServer((req, res) => {
  hits++;
  redditRequests.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, ua: req.headers['user-agent'] ?? null });
  if (req.url === '/api/v1/access_token') {
    if (redditMode === 'badcreds') {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"Unauthorized","error":401}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'stub-token', token_type: 'bearer', expires_in: 86400, scope: '*' }));
    return;
  }
  if (redditMode === 'forbidden') {
    res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"Forbidden","error":403}');
    return;
  }
  if (listing === 'down') {
    res.writeHead(503).end('unavailable');
    return;
  }
  if (listing === 'garbage') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ not: 'a listing' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(listing));
});
await new Promise((r) => feed.listen(0, '127.0.0.1', r));
const feedUrl = `http://127.0.0.1:${feed.address().port}`;

// ── The stub YouTube Data API ───────────────────────────────────────────────
//
// Answers /youtube/v3/videos (chart=mostPopular by category, or id=… for statistics) and
// /youtube/v3/search (by q). Every request is recorded so the harness can assert what was
// asked — including that a refusal asked nothing.
const H = 3_600_000;
const video = (id, title, hoursOld, views) => ({
  kind: 'youtube#video',
  id,
  snippet: { title, publishedAt: new Date(NOW - hoursOld * H).toISOString(), channelTitle: 'Stub', categoryId: '28' },
  statistics: { viewCount: String(views), likeCount: '1' },
});
const V1 = video('vidAAAAAAA1', 'Why bridges hum in the wind, explained', 10, 50_000); // 5000/h
const V2 = video('vidAAAAAAA2', 'The physics of a falling cat, slowed down', 4, 1_000); // 250/h
const VS = video('vidSEARCH01', 'How a fridge actually moves heat outside', 72, 7_200); // 100/h
const YT = {
  mostPopular: { 28: [V1], 27: [V2, V1] }, // V1 twice: deduplicated by id within the run
  search: { 'how fridges work': ['vidSEARCH01'], 'cat physics': ['vidAAAAAAA2'] },
  byId: { vidSEARCH01: VS, vidAAAAAAA1: V1, vidAAAAAAA2: V2 },
};
let ytMode = 'ok';
const ytRequests = [];

const ytServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  ytRequests.push(u);
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (ytMode === 'quota') {
    send(403, { error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.', errors: [{ reason: 'quotaExceeded', domain: 'youtube.quota' }] } });
    return;
  }
  if (u.pathname === '/youtube/v3/videos' && u.searchParams.get('chart') === 'mostPopular') {
    send(200, { kind: 'youtube#videoListResponse', items: YT.mostPopular[u.searchParams.get('videoCategoryId')] ?? [] });
    return;
  }
  if (u.pathname === '/youtube/v3/videos' && u.searchParams.get('id')) {
    send(200, { items: u.searchParams.get('id').split(',').map((id) => YT.byId[id]).filter(Boolean) });
    return;
  }
  if (u.pathname === '/youtube/v3/search') {
    const ids = YT.search[u.searchParams.get('q')] ?? [];
    send(200, { items: ids.map((videoId) => ({ id: { kind: 'youtube#video', videoId }, snippet: YT.byId[videoId].snippet })) });
    return;
  }
  send(404, { error: { code: 404, message: `stub has no ${u.pathname}` } });
});
await new Promise((r) => ytServer.listen(0, '127.0.0.1', r));
const ytUrl = `http://127.0.0.1:${ytServer.address().port}`;

// ── The stub Google Trends RSS feed ─────────────────────────────────────────
// Written from the feed's published shape (<ht:approx_traffic>, <ht:news_item>…); the real
// feed is refused at this container's egress, so this is the shape, not a captured response.
/** 'empty' (a valid feed with no items — the default, so other sections' counts are unchanged) | 'ok' | 'down' | 'changed'. */
let gtMode = 'empty';
const gtRequests = [];
const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:ht="https://trends.google.com/trending/rss" version="2.0">
  <channel><title>Daily Search Trends</title><description>Recent searches</description><link>https://trends.google.com/trending/rss?geo=IN</link>
  ${items}
  </channel>
</rss>`;
const gtItem = (title, traffic) => `<item><title>${title}</title><ht:approx_traffic>${traffic}</ht:approx_traffic><description></description>
  <link>https://trends.google.com/trending/rss?geo=IN</link><pubDate>Mon, 3 Aug 2026 11:00:00 +0530</pubDate>
  <ht:news_item><ht:news_item_title>Why &amp; how — explained</ht:news_item_title><ht:news_item_url>https://news.invalid/a</ht:news_item_url><ht:news_item_source>Stub</ht:news_item_source></ht:news_item></item>`;
const gtServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  gtRequests.push(u);
  if (gtMode === 'down') return void res.writeHead(500).end('nope');
  if (gtMode === 'changed') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>We moved</body></html>');
  const geo = u.searchParams.get('geo');
  const items = gtMode === 'ok' ? (geo === 'IN' ? gtItem('monsoon forecast for kerala', '2,000+') + gtItem('why is the moon orange tonight', '10K+') : gtItem('daylight saving time ends', '200K+')) : '';
  res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' }).end(rss(items));
});
await new Promise((r) => gtServer.listen(0, '127.0.0.1', r));
const gtUrl = `http://127.0.0.1:${gtServer.address().port}`;

process.env.APP_URL ??= 'https://harness.invalid';
process.env.WEBHOOK_CALLBACK_BASE_URL ??= 'https://harness.invalid';
process.env.ALLOWED_EMAIL ??= 'harness@invalid.test';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://harness.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'harness';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { runTrends, runTrendsForAllChannels } = require(`${BUILD}/trends/run.js`);
const { startTrendsRun } = require(`${BUILD}/trends/run-now.js`);
const { latestTrendRun } = require(`${BUILD}/trends/runs.js`);
const { parseApproxTraffic } = require(`${BUILD}/drivers/trends-google.js`);
const { BUREAU_TOOLS, NO_EFFECTS } = require(`${BUILD}/bureau/mcp/surface.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};
const check = (cond, l, d = '') => (cond ? ok(l, d) : bad(l, d));

const scratch = await scratchDatabase(dbUrl, 'trends');
const client = scratch.client;
const db = supabaseShim(client);

// Channel A is the Bureau, seeded by migration 0037 with its bible folder in this build.
// Channel B is inserted here with a slug that has no bible folder.
const A = 'b0000000-0000-4000-8000-000000000001';
const A_SLUG = 'bureau-of-reality';
const B = 'b0000000-0000-4000-8000-0000000000b2';
const B_SLUG = 'harness-b';
await client.query(
  `insert into channels (id, name, platform, niche, is_active, slug, created_at)
   values ($1, 'Harness Channel B', 'youtube', 'harness', true, $2, now() + interval '1 day')`,
  [B, B_SLUG],
);

const post = (title, score, hoursOld, permalink) => ({
  data: {
    title,
    score,
    created_utc: NOW / 1000 - hoursOld * 3600,
    num_comments: 12,
    subreddit: 'infrastructure',
    ...(permalink ? { permalink } : {}),
  },
});
const asListing = (posts) => ({ data: { children: posts } });

// `youtubeApiKey` is a required dep and passed explicitly — the refusal for a missing key is
// §8, and a harness that leaned on the environment could not reach it.
const CREDS = { clientId: 'harness-client', clientSecret: 'harness-secret' };
const DEPS = { db, baseUrl: feedUrl, redditCredentials: CREDS, youtubeApiKey: 'harness-key', youtubeBaseUrl: ytUrl, googleTrendsBaseUrl: gtUrl, runKind: 'harness', now: NOW };
const ROAD_SALT = 'Road salt is dissolving bridge decks faster than expected';
const ROAD_SALT_LINK = '/r/infrastructure/comments/abc123/road_salt_is_dissolving/';

const count = async (where, params = []) =>
  Number((await client.query(`select count(*)::int as n from trend_signals where ${where}`, params)).rows[0].n);

console.log('\nStage 1 — trend intake\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. Signals land, with the reading, the raw payload and the channel\n');
{
  listing = asListing([
    post(ROAD_SALT, 500, 2, ROAD_SALT_LINK),
    post('The winter maintenance budget problem nobody talks about', 100, 20),
    post('short', 900, 1),
  ]);

  const out = await runTrends({ channelId: A, subreddits: ['infrastructure'] }, DEPS);

  check(out.inserted === 2, 'two of three land', out.inserted === 2 ? 'the third is under the term-length floor' : JSON.stringify(out.sources));

  const { rows } = await client.query(
    `select term, velocity, volume, channel_id, raw->>'subreddit' as sub
       from trend_signals where source = 'reddit' order by velocity desc`,
  );

  // 500 points in 2 hours is 250/h; 100 in 20 hours is 5/h. The ordering is the whole
  // point of the proxy — a fast small post beats a slow big one.
  check(Number(rows[0]?.velocity) === 250, '  · velocity is score over age', `${rows[0]?.velocity}/h from 500 points in 2h`);
  check(Number(rows[1]?.velocity) === 5, '  · and a slower post ranks below', JSON.stringify(rows[1]));
  check(rows[0]?.sub === 'infrastructure', '  · with the untouched payload kept', "raw->>'subreddit'");
  check(rows.length === 2 && rows.every((r) => r.channel_id === A), '  · both rows carry channel A', JSON.stringify(rows.map((r) => r.channel_id)));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. The same term twice in a day updates, and keeps the later reading\n');
{
  listing = asListing([post(ROAD_SALT, 1200, 4, ROAD_SALT_LINK)]);

  const before = await count('true');
  const out = await runTrends({ channelId: A, subreddits: ['infrastructure'] }, DEPS);
  const after = await count('true');

  check(after === before && out.updated === 1, 'no new row', `${before} → ${after}, updated ${out.updated}`);

  const { rows } = await client.query(`select velocity, volume from trend_signals where term = $1`, [ROAD_SALT]);
  // 1200 over 4 hours is 300/h, up from 250. The newer measurement must win.
  check(
    rows.length === 1 && Number(rows[0].velocity) === 300 && Number(rows[0].volume) === 1200,
    '  · and the newer reading replaced the older',
    JSON.stringify(rows),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. A bad feed is one source failing, not a failed run\n');
{
  listing = 'garbage';
  const garbage = await runTrends({ channelId: A, subreddits: ['infrastructure'] }, DEPS);
  const gr = garbage.sources.find((s) => s.source === 'reddit');
  check(garbage.ok && garbage.inserted === 0 && gr?.ok === false && gr.detail === 'r/infrastructure: unexpected response shape', 'a malformed listing writes nothing and is said, not skipped', gr?.detail);

  listing = 'down';
  const down = await runTrends({ channelId: A, subreddits: ['infrastructure'] }, DEPS);
  const reddit = down.sources.find((s) => s.source === 'reddit');
  check(down.ok && reddit && !reddit.ok && reddit.detail === 'r/infrastructure: HTTP 503', 'a source that is down is reported', reddit?.detail);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. Unconfigured and unbuilt sources refuse rather than returning nothing\n');
{
  listing = asListing([]);
  const out = await runTrends({ channelId: A, subreddits: [], youtube: null, googleTrends: null }, DEPS);

  const yt = out.sources.find((s) => s.source === 'youtube');
  const gt = out.sources.find((s) => s.source === 'google_trends');
  const rd = out.sources.find((s) => s.source === 'reddit');
  check(rd && !rd.ok && rd.detail === 'not configured: this channel lists no subreddits', 'reddit with no subreddits says it is not configured', rd?.detail);

  check(
    yt && !yt.ok && yt.count === 0 && /^not configured: /.test(yt.detail ?? ''),
    'youtube with no config block says it is not configured',
    yt?.detail,
  );
  // An empty list from a source nobody wrote is indistinguishable from a quiet day.
  check(
    gt && !gt.ok && gt.count === 0 && gt.detail === 'not configured: this channel’s trend sources turn Google Trends off (google_trends: null)',
    'google_trends turned off says so, by the field that turned it off',
    gt?.detail,
  );

  // No subreddits means no request at all, rather than a request to a default.
  const before = hits;
  const ytBefore = ytRequests.length;
  const gtBefore = gtRequests.length;
  await runTrends({ channelId: A, subreddits: [], googleTrends: null }, DEPS);
  check(hits === before && ytRequests.length === ytBefore && gtRequests.length === gtBefore, '  · and an empty config fetches nothing', `${hits - before} reddit, ${ytRequests.length - ytBefore} youtube, ${gtRequests.length - gtBefore} google request(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. YouTube: chart and search land as exact rows under the channel\n');
const YT_CFG = { region_code: 'IN', category_ids: ['28', '27'], queries: ['how fridges work', 'cat physics'] };
{
  ytRequests.length = 0;
  const out = await runTrends({ channelId: A, subreddits: [], youtube: YT_CFG }, DEPS);
  const yt = out.sources.find((s) => s.source === 'youtube');
  check(yt?.ok === true && yt.count === 3, 'the source reports three distinct videos', JSON.stringify(yt));

  const { rows } = await client.query(
    `select term, velocity, volume, region, channel_id, raw->>'id' as vid, raw->'kiln_via'->>'via' as via
       from trend_signals where source = 'youtube' order by term`,
  );
  // Seeded inputs → computed outputs. 50 000 views in 10 h = 5000/h; 1 000 in 4 h = 250/h;
  // the search hit's numbers come from the statistics call: 7 200 in 72 h = 100/h.
  const got = rows.map((r) => ({ term: r.term, velocity: Number(r.velocity), volume: Number(r.volume), region: r.region, channel: r.channel_id, vid: r.vid, via: r.via }));
  const want = [
    { term: VS.snippet.title, velocity: 100, volume: 7200, region: 'IN', channel: A, vid: 'vidSEARCH01', via: 'search' },
    { term: V2.snippet.title, velocity: 250, volume: 1000, region: 'IN', channel: A, vid: 'vidAAAAAAA2', via: 'mostPopular' },
    { term: V1.snippet.title, velocity: 5000, volume: 50000, region: 'IN', channel: A, vid: 'vidAAAAAAA1', via: 'mostPopular' },
  ].sort((a, b) => a.term.localeCompare(b.term));
  let same = true;
  try {
    deepStrictEqual(got, want);
  } catch {
    same = false;
  }
  check(same, '  · exactly three youtube rows, exact velocity/volume, source youtube, channel A', JSON.stringify(got));

  // What was asked: 2 chart calls (one per category), 2 searches, 1 statistics batch for the
  // one search hit not already seen. 'cat physics' found V2, already seen from the chart.
  const shape = ytRequests.map((u) => `${u.pathname.split('/').pop()}:${u.searchParams.get('videoCategoryId') ?? u.searchParams.get('q') ?? u.searchParams.get('id')}`);
  check(
    JSON.stringify(shape) === JSON.stringify(['videos:28', 'videos:27', 'search:how fridges work', 'search:cat physics', 'videos:vidSEARCH01']),
    '  · five requests, in the documented shapes',
    shape.join(' '),
  );
  const s0 = ytRequests[2];
  check(
    ytRequests.every((u) => u.searchParams.get('key') === 'harness-key') &&
      s0.searchParams.get('publishedAfter') === new Date(NOW - 7 * 86_400_000).toISOString() &&
      s0.searchParams.get('order') === 'viewCount' && s0.searchParams.get('type') === 'video' && s0.searchParams.get('regionCode') === 'IN',
    '  · key on every call; search is a week of viewCount-ordered videos in IN',
    s0.search,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. Channel B writes under B only, and never touches A\n');
{
  const aBefore = (await client.query(`select id, term, velocity, volume, captured_at from trend_signals where channel_id = $1 order by id`, [A])).rows;
  listing = asListing([post(ROAD_SALT, 40, 8, ROAD_SALT_LINK)]); // the same post A already holds
  const out = await runTrends({ channelId: B, subreddits: ['infrastructure'], youtube: YT_CFG }, DEPS);
  const aAfter = (await client.query(`select id, term, velocity, volume, captured_at from trend_signals where channel_id = $1 order by id`, [A])).rows;

  check(JSON.stringify(aAfter) === JSON.stringify(aBefore), "channel A's rows are byte-for-byte unchanged", `${aBefore.length} rows`);
  // Per-channel dedup: B's road-salt observation is B's own row (5/h), not an update of A's.
  check(out.inserted === 4 && out.updated === 0, '  · B inserted its own 4 rows (1 reddit + 3 youtube), updated none', `inserted ${out.inserted}, updated ${out.updated}`);
  check((await count('channel_id = $1', [B])) === 4, '  · and exactly 4 rows carry channel B', '');
  const bSalt = (await client.query(`select velocity from trend_signals where channel_id = $1 and term = $2`, [B, ROAD_SALT])).rows;
  check(bSalt.length === 1 && Number(bSalt[0].velocity) === 5, "  · B's reading of the shared post is B's (40 in 8h = 5/h)", JSON.stringify(bSalt));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n7. The schedule runs every channel with a bible, and skips the rest by name\n');
{
  listing = asListing([post('A brand new post about expansion joints and heat', 90, 3)]);
  const aBefore = await count('channel_id = $1', [A]);
  const bBefore = await count('channel_id = $1', [B]);
  const outcomes = await runTrendsForAllChannels(DEPS);
  const a = outcomes.find((o) => o.channelId === A);
  const b = outcomes.find((o) => o.channelId === B);
  check(a?.ran === true, 'channel A (bible in this build) ran', JSON.stringify(a?.ran ? a.result.sources.map((s) => `${s.source}:${s.ok}`) : a));
  check(b?.ran === false && b.skipped === `no bible (database or folder) for slug ${B_SLUG}`, 'channel B (no bible in the database or as a folder) is skipped by name', b?.ran === false ? b.skipped : JSON.stringify(b));
  // The Bureau lists 5 subreddits; the stub serves the same one post for each, so one new
  // term lands once and is updated four times. B gets nothing.
  check((await count('channel_id = $1', [A])) === aBefore + 1, "  · A's new post landed once under A", '');
  check((await count('channel_id = $1', [B])) === bBefore, '  · and nothing new under B', '');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n8. A missing key refuses by name and asks nothing; quota is named\n');
{
  ytRequests.length = 0;
  const before = await count(`source = 'youtube' and channel_id = $1`, [B]);
  const out = await runTrends({ channelId: B, subreddits: [], youtube: YT_CFG }, { ...DEPS, youtubeApiKey: null });
  const yt = out.sources.find((s) => s.source === 'youtube');
  check(yt && !yt.ok && yt.count === 0 && (yt.detail ?? '').startsWith('refused: YOUTUBE_DATA_API_KEY is not set'), 'youtube refuses naming YOUTUBE_DATA_API_KEY', yt?.detail);
  check(/YouTube Data API v3/.test(yt?.detail ?? '') && /Credentials → API key/.test(yt?.detail ?? ''), '  · and says where the key comes from', '');
  check(ytRequests.length === 0, '  · no request was made', `${ytRequests.length}`);
  check((await count(`source = 'youtube' and channel_id = $1`, [B])) === before, '  · zero youtube rows written', '');

  // A youtube block that lists nothing asks for nothing: "not configured", not a key refusal.
  const empty = await runTrends({ channelId: B, subreddits: [], youtube: { region_code: 'IN', category_ids: [], queries: [] } }, { ...DEPS, youtubeApiKey: null });
  const ey = empty.sources.find((s) => s.source === 'youtube');
  check(
    ey?.detail === 'not configured: this channel’s youtube block lists no category_ids and no queries' && ytRequests.length === 0,
    'an empty youtube block is "not configured", not a key refusal, and asks nothing',
    ey?.detail,
  );

  ytMode = 'quota';
  const q = await runTrends({ channelId: B, subreddits: [], youtube: YT_CFG }, DEPS);
  ytMode = 'ok';
  const qy = q.sources.find((s) => s.source === 'youtube');
  check(qy && !qy.ok && qy.count === 0 && (qy.detail ?? '').startsWith('HTTP 403 quotaExceeded'), 'a quota-exceeded 403 is reported by name', qy?.detail);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n9. Run now: approver only, then the task gets the channel and its trends.json\n');
{
  // From disk, not from the bible module: the module is what is under test.
  const disk = JSON.parse(readFileSync(new URL(`../channels/${A_SLUG}/trends.json`, import.meta.url), 'utf8'));
  const calls = [];
  const trigger = async (payload) => {
    calls.push(payload);
    return { id: 'run_harness_1' };
  };
  // The approver is a signed-in, allow-listed user WITH a profiles row. Seeded input: the
  // row; asserted output: what startTrendsRun did with it.
  const approverId = (await client.query(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'approver@invalid.test', 88) returning id`)).rows[0].id;
  const strangerId = 'c0000000-0000-4000-8000-0000000000c3'; // signed in and allowed, no profile row

  const r = await startTrendsRun(db, A, { trigger, user: { id: approverId, emailAllowed: true } });
  check(r.status === 'ok' && r.runId === 'run_harness_1', 'the approver gets the handle id back', JSON.stringify(r));
  let same = calls.length === 1;
  try {
    deepStrictEqual(calls[0], { channelId: A, subreddits: disk.subreddits, youtube: disk.youtube });
  } catch {
    same = false;
  }
  check(same, '  · trigger called once with channel A and channels/bureau-of-reality/trends.json', JSON.stringify(calls[0]));

  const refusals = [
    ['no session', await startTrendsRun(db, A, { trigger, user: null }), 'refused: not signed in'],
    ['an address not on the allow-list', await startTrendsRun(db, A, { trigger, user: { id: approverId, emailAllowed: false } }), 'refused: this address is not on ALLOWED_EMAIL'],
    ['an allowed user with no profiles row', await startTrendsRun(db, A, { trigger, user: { id: strangerId, emailAllowed: true } }), 'refused: the signed-in user has no profiles row'],
    ['a channel with no bible (by slug)', await startTrendsRun(db, B, { trigger, user: { id: approverId, emailAllowed: true } }), `refused: “Harness Channel B” has no bible (slug ${B_SLUG})`],
    ['an unknown channel', await startTrendsRun(db, 'c0000000-0000-4000-8000-0000000000d4', { trigger, user: { id: approverId, emailAllowed: true } }), 'refused: channel c0000000-0000-4000-8000-0000000000d4 is not an active channel'],
    [
      'trend sources with nothing in them',
      await startTrendsRun(db, A, { trigger, user: { id: approverId, emailAllowed: true }, trendsFor: () => ({ subreddits: [], youtube: { region_code: 'IN', category_ids: [], queries: [] }, google_trends: null }) }),
      `refused: Bureau of Reality's trend sources list no subreddits, no YouTube categories or queries, and turn Google Trends off`,
    ],
  ];
  for (const [what, res, prefix] of refusals) {
    check(res.status === 'error' && (res.message ?? '').startsWith(prefix) && res.runId === undefined, `${what} is refused by name`, res.message);
  }
  check(calls.length === 1, '  · and none of those six reached trigger', `${calls.length} call(s) in total`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n10. trends_recent answers for the token’s channel only\n');
const tool = BUREAU_TOOLS.find((t) => t.name === 'trends_recent');
const ctxFor = (channelId) => ({
  db,
  token: { id: null, scope: 'agent', channelId, profileId: null, name: 'verify-trends' },
  effects: NO_EFFECTS,
  channel: { id: channelId, name: 'harness', bible: null, refusal: null },
});
{
  check(tool?.scope === 'any', 'the tool exists and is agent-scope', tool?.scope);
  // A row with no velocity, for the nulls-last ordering. Seeded input; the order is the output.
  const NULL_TERM = 'A signal whose source gave no velocity at all';
  await client.query(
    `insert into trend_signals (source, term, velocity, volume, channel_id, captured_at) values ('reddit', $1, null, null, $2, now())`,
    [NULL_TERM, A],
  );

  const r = await tool.run(ctxFor(A), tool.args.parse({ days: 30, limit: 50 }));
  const expected = (
    await client.query(
      `select term from trend_signals where channel_id = $1 and captured_at >= now() - interval '30 days'
        order by velocity desc nulls last`,
      [A],
    )
  ).rows.map((x) => x.term);
  const terms = r.ok ? r.signals.map((s) => s.term) : [];
  check(r.ok === true && r.scope === 'channel' && r.scope_note === undefined && JSON.stringify(terms) === JSON.stringify(expected), "A's rows only, velocity desc, nulls last", `${terms.length} of ${expected.length}`);
  check(r.ok && terms.at(-1) === NULL_TERM, '  · the null-velocity row is last', terms.at(-1));
  check(r.ok && r.signals.every((s) => s.velocity === null || typeof s.velocity === 'number') && r.signals.every((s) => s.volume === null || typeof s.volume === 'number'), '  · numeric columns arrive as numbers, not strings', '');

  const v1 = r.ok ? r.signals.find((s) => s.term === V1.snippet.title) : null;
  check(v1?.velocity === 5000 && v1?.volume === 50000 && v1?.url === 'https://www.youtube.com/watch?v=vidAAAAAAA1', '  · youtube link from raw.id, exact numbers', JSON.stringify(v1));
  const salt = r.ok ? r.signals.find((s) => s.term === ROAD_SALT) : null;
  check(salt?.velocity === 300 && salt?.url === `https://www.reddit.com${ROAD_SALT_LINK}`, '  · reddit link from raw.permalink', JSON.stringify(salt));

  const top = await tool.run(ctxFor(A), tool.args.parse({}));
  check(top.ok && top.signals.length === Math.min(20, expected.length) && top.signals[0].term === expected[0], '  · defaults: 7 days, 20 rows, highest first', `${top.ok ? top.signals.length : JSON.stringify(top)}`);

  const bySlugB = await tool.run(ctxFor(A), tool.args.parse({ channel: B_SLUG }));
  check(
    bySlugB.ok === false && bySlugB.refused === true && bySlugB.summary.startsWith('trends_recent answers for this token’s channel only'),
    "channel B by slug is refused for A's token",
    bySlugB.summary,
  );
  const byIdB = await tool.run(ctxFor(A), tool.args.parse({ channel: B }));
  check(byIdB.ok === false && byIdB.refused === true, '  · and by id', '');
  const bySlugA = await tool.run(ctxFor(A), tool.args.parse({ channel: A_SLUG }));
  check(bySlugA.ok === true && bySlugA.count === top.count, "  · A's own slug is accepted", '');

  const asB = await tool.run(ctxFor(B), tool.args.parse({ days: 30, limit: 50 }));
  const bTerms = (await client.query(`select term from trend_signals where channel_id = $1`, [B])).rows.map((x) => x.term).sort();
  check(asB.ok && JSON.stringify(asB.signals.map((s) => s.term).sort()) === JSON.stringify(bTerms), "B's token sees B's rows only", `${asB.ok ? asB.count : JSON.stringify(asB)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n11. Nothing here costs money\n');
{
  const { rows } = await client.query(`select count(*)::int as n from cost_ledger`);
  // Asserted rather than assumed: the whole ledger, not a stage filter, so a row written
  // under any stage name by anything this harness drove would show.
  check(rows[0].n === 0, 'no cost_ledger rows at all', 'public feed and a free-within-quota API');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n13. Every source says what happened, and the run records it (trend_runs, 0049)\n');
{
  // a. Reddit refusing (as it does unauthenticated since 28-May-2026) is a recorded refusal.
  redditMode = 'forbidden';
  listing = asListing([post('This post must never land because the listing is refused', 50, 1)]);
  const before = await count(`source = 'reddit'`);
  const refused = await runTrends({ channelId: A, subreddits: ['infrastructure'], youtube: YT_CFG }, DEPS);
  redditMode = 'ok';
  const r = refused.sources.find((x) => x.source === 'reddit');
  check(refused.ok && r?.ok === false && r.count === 0 && r.detail === 'r/infrastructure: refused 403 — needs an app (Reddit refuses reads that are not authenticated, or this app is not allowed this subreddit).', 'Reddit 403 is a named refusal, and the run goes on', r?.detail);
  check((await count(`source = 'reddit'`)) === before, '  · no reddit row written', '');
  const yt = refused.sources.find((x) => x.source === 'youtube');
  check(yt?.ok === true && yt.count === 3, '  · YouTube in the same run still collected its 3', JSON.stringify(yt));
  const last = await latestTrendRun(db, A);
  const recorded = last.ok && last.run ? last.run.sources.find((x) => x.source === 'reddit') : null;
  check(
    last.ok && last.run?.trigger === 'harness' && recorded?.detail === r?.detail && last.run.sources.map((x) => x.source).join() === 'reddit,youtube,google_trends',
    '  · the trend_runs row the screen reads carries every source, Reddit’s refusal word for word',
    JSON.stringify(last.ok ? last.run?.sources : last),
  );

  // b. No credentials: "not configured" by name, and not one request to Reddit.
  const hitsBefore = hits;
  const nocreds = await runTrends({ channelId: A, subreddits: ['infrastructure'], googleTrends: null }, { ...DEPS, redditCredentials: null });
  const nr = nocreds.sources.find((x) => x.source === 'reddit');
  check(nr?.ok === false && (nr.detail ?? '').startsWith('not configured: REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET are not set') && hits === hitsBefore, 'no app credentials: Reddit is "not configured" by name and nothing is asked', `${nr?.detail} · ${hits - hitsBefore} request(s)`);
  redditMode = 'badcreds';
  const bad = await runTrends({ channelId: A, subreddits: ['infrastructure'], googleTrends: null }, DEPS);
  redditMode = 'ok';
  check((bad.sources.find((x) => x.source === 'reddit')?.detail ?? '').startsWith('token: refused 401 — Reddit rejected REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET'), 'wrong credentials: the token refusal names the variables', bad.sources[0]?.detail);

  // c. With credentials: one token (Basic, the app's id:secret), then listings with the Bearer.
  redditRequests.length = 0;
  listing = asListing([post('Authenticated reads land like the old public ones did', 300, 3)]);
  const authed = await runTrends({ channelId: A, subreddits: ['infrastructure'], googleTrends: null }, DEPS);
  const ar = authed.sources.find((x) => x.source === 'reddit');
  const tokenReq = redditRequests.find((x) => x.path === '/api/v1/access_token');
  const listReq = redditRequests.find((x) => x.path.startsWith('/r/infrastructure/hot'));
  check(ar?.ok === true && ar.count === 1 && authed.inserted === 1, 'with credentials, Reddit signals land', JSON.stringify(ar));
  check(tokenReq?.method === 'POST' && tokenReq.auth === `Basic ${Buffer.from('harness-client:harness-secret').toString('base64')}`, '  · the token is asked for with the app’s id and secret', tokenReq?.auth);
  check(listReq?.auth === 'Bearer stub-token' && /^server:kiln-trends:/.test(listReq.ua ?? ''), '  · and the listing is read with that token and a descriptive User-Agent', `${listReq?.auth} · ${listReq?.ua}`);
  const v = (await client.query(`select velocity, volume from trend_signals where term = 'Authenticated reads land like the old public ones did'`)).rows[0];
  check(Number(v?.velocity) === 100 && Number(v?.volume) === 300, '  · velocity is still score per hour (300 in 3 h = 100)', JSON.stringify(v));

  // d. Google Trends from the RSS feed: default countries, approximate traffic as volume.
  check(parseApproxTraffic('2,000+') === 2000 && parseApproxTraffic('10K+') === 10000 && parseApproxTraffic('1.5M+') === 1500000 && parseApproxTraffic('lots') === null && parseApproxTraffic(null) === null, 'approximate traffic parses as a lower bound, and an unreadable one is null, not zero');
  gtMode = 'ok';
  gtRequests.length = 0;
  const g = await runTrends({ channelId: A, subreddits: [] }, DEPS);
  const gs = g.sources.find((x) => x.source === 'google_trends');
  check(gs?.ok === true && gs.count === 3 && gtRequests.map((u) => u.searchParams.get('geo')).join() === 'IN,US', 'no google_trends block: the default countries IN and US are read, 3 searches', `${JSON.stringify(gs)} · ${gtRequests.map((u) => u.search).join(' ')}`);
  const rows = (await client.query(`select term, region, velocity, volume, raw->'news'->0->>'title' as news from trend_signals where source = 'google_trends' and channel_id = $1 order by volume`, [A])).rows;
  check(
    JSON.stringify(rows.map((x) => [x.term, x.region, x.velocity, Number(x.volume)])) ===
      JSON.stringify([['monsoon forecast for kerala', 'IN', null, 2000], ['why is the moon orange tonight', 'IN', null, 10000], ['daylight saving time ends', 'US', null, 200000]]),
    '  · each lands with its country, its traffic as volume, and no velocity (null, not zero)',
    JSON.stringify(rows),
  );
  check(rows[0]?.news === 'Why & how — explained', '  · and the news item behind it, entities decoded', rows[0]?.news);
  gtRequests.length = 0;
  await runTrends({ channelId: A, subreddits: [], googleTrends: { geo: ['GB'] } }, DEPS);
  check(gtRequests.map((u) => u.searchParams.get('geo')).join() === 'GB', '  · a channel’s own countries replace the default', gtRequests.map((u) => u.search).join());

  // e. A feed that is down or has changed shape is said, and never fails the run.
  for (const [mode, expect] of [['down', 'geo IN: HTTP 500 — the trending feed did not answer'], ['changed', 'geo IN: unexpected feed shape: no <rss><channel>']]) {
    gtMode = mode;
    const out = await runTrends({ channelId: A, subreddits: ['infrastructure'] }, DEPS);
    const x = out.sources.find((y) => y.source === 'google_trends');
    check(out.ok && x?.ok === false && x.detail === expect && out.sources.find((y) => y.source === 'reddit')?.ok === true, `Google feed ${mode}: one source failing, said by name; Reddit in the same run is fine`, x?.detail);
  }
  gtMode = 'empty';
  // §12 compares an ordering by velocity, and Google rows have none (null): ties among nulls
  // have no defined order, so they are removed here rather than loosening §12's assertion.
  await client.query(`delete from trend_signals where source = 'google_trends'`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n12. A database without 0046’s column still collects, and says so\n');
{
  // Hosted may not have 0046 pasted yet. Dropped on the scratch database only.
  await client.query(`alter table trend_signals drop column channel_id`);
  listing = asListing([post('Expansion joints are why bridges have teeth', 60, 2)]);
  const out = await runTrends({ channelId: A, subreddits: ['infrastructure'] }, DEPS);
  check(out.inserted === 1 && (out.channelColumnMissing ?? '').includes('migration 0046 not applied'), 'the row lands without a channel, and the result says why', out.channelColumnMissing);
  // Falls back to unfiltered — there is no per-channel fact to filter on — and says so.
  const r = await tool.run(ctxFor(B), tool.args.parse({ days: 30, limit: 50 }));
  const all = (
    await client.query(`select term from trend_signals where captured_at >= now() - interval '30 days' order by velocity desc nulls last`)
  ).rows.map((x) => x.term);
  const got = r.ok ? r.signals.map((s) => s.term) : [];
  check(
    r.ok === true && r.scope === 'workspace' && (r.scope_note ?? '').startsWith('migration 0046 not applied') && JSON.stringify(got) === JSON.stringify(all),
    'trends_recent falls back to every row, unfiltered, and names the migration',
    r.ok ? `${got.length} of ${all.length}; ${r.scope_note}` : JSON.stringify(r),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n14. A database without trend_runs (0049 not pasted) still collects, and says so\n');
{
  await client.query(`drop table trend_runs`);
  listing = asListing([post('Signals still land when the run log table is missing', 40, 2)]);
  const out = await runTrends({ channelId: A, subreddits: ['infrastructure'], googleTrends: null }, DEPS);
  check(out.inserted === 1 && (out.runLogMissing ?? '').includes('migration 0049 not pasted'), 'the signal lands and the result names 0049', out.runLogMissing);
  const last = await latestTrendRun(db, A);
  check(last.ok === false && last.reason.startsWith('Per-run source results need migration 0049'), '  · and the screen’s reader says why it has nothing, rather than "never ran"', last.ok ? 'ok' : last.reason);
}

feed.close();
ytServer.close();
gtServer.close();
await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nStage 1 collects per channel, deduplicates, refuses by name and reports what it could not reach.\n' +
    'What is left: a real run against the real feeds with a real key, which only a deploy can do.\n',
);
