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
 * ALSO (§15): Wikipedia and Hacker News map exactly (seeded feed → asserted rows), filter
 *          non-articles and non-stories, ask yesterday and the day before with the descriptive
 *          User-Agent, keep velocity null where it is absent, and a 500 from either is named
 *          while the other lands.
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
  // The body the hosted run received for category 27 in IN (07-Oct 14:25 UTC), verbatim in shape.
  if (ytMode === 'chart404' && u.searchParams.get('chart') === 'mostPopular' && u.searchParams.get('videoCategoryId') === '27') {
    send(404, { error: { code: 404, message: 'Requested entity was not found.', errors: [{ message: 'Requested entity was not found.', domain: 'global', reason: 'notFound' }] } });
    return;
  }
  if (ytMode === 'chart404' && u.pathname === '/youtube/v3/search' && u.searchParams.get('q') === 'cat physics') {
    send(500, { error: { code: 500, message: 'Backend Error', errors: [{ reason: 'backendError' }] } });
    return;
  }
  if (ytMode === 'allfail') {
    send(404, { error: { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] } });
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

// ── The stub Wikimedia pageviews API ────────────────────────────────────────
// Shape from the API's documentation (items[0].articles[{article, views, rank}]). Every request
// is recorded with its User-Agent, because Wikimedia's policy is the one requirement it has.
/** 'empty' (no articles — the default, so other sections' counts are unchanged) | 'ok' | 'down' | 'noprev'. */
let wikiMode = 'empty';
const wikiRequests = [];
const wikiTop = (y, m, d, articles) => ({ items: [{ project: 'en.wikipedia', access: 'all-access', year: y, month: m, day: d, articles }] });
const WIKI_YESTERDAY = [
  { article: 'Main_Page', views: 5_000_000, rank: 1 },
  { article: 'Special:Search', views: 900_000, rank: 2 },
  { article: '-', views: 400_000, rank: 3 },
  { article: 'Oumuamua_(interstellar_object)', views: 120_000, rank: 4 },
  { article: 'Wikipedia:Featured_pictures', views: 90_000, rank: 5 },
  { article: 'Dune:_Part_Two', views: 80_000, rank: 6 },
  { article: 'File:Black_hole_M87.jpg', views: 70_000, rank: 7 },
  { article: 'Superconductivity', views: 60_000, rank: 8 },
];
const WIKI_DAY_BEFORE = [
  { article: 'Main_Page', views: 4_900_000, rank: 1 },
  { article: 'Superconductivity', views: 75_000, rank: 2 },
  { article: 'Oumuamua_(interstellar_object)', views: 20_000, rank: 3 },
];
const wikiServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  wikiRequests.push({ path: u.pathname, ua: req.headers['user-agent'] ?? null });
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const m = /^\/api\/rest_v1\/metrics\/pageviews\/top\/([a-z-]+)\.wikipedia\/all-access\/(\d{4})\/(\d{2})\/(\d{2})$/.exec(u.pathname);
  if (!m) return send(404, { title: 'Not found.' });
  if (wikiMode === 'down') return send(500, { title: 'Internal error' });
  // NOW is 2026-08-03 12:00 UTC: yesterday is 08/02, the day before 08/01.
  if (`${m[2]}/${m[3]}/${m[4]}` === '2026/08/02') return send(200, wikiTop(m[2], m[3], m[4], wikiMode === 'empty' ? [] : WIKI_YESTERDAY));
  if (`${m[2]}/${m[3]}/${m[4]}` === '2026/08/01' && wikiMode === 'ok') return send(200, wikiTop(m[2], m[3], m[4], WIKI_DAY_BEFORE));
  return send(404, { title: 'Not found.', detail: 'The date(s) you used are valid, but we either do not have data for those date(s), or the project you asked for is not loaded yet.' });
});
await new Promise((r) => wikiServer.listen(0, '127.0.0.1', r));
const wikiUrl = `http://127.0.0.1:${wikiServer.address().port}`;

// ── The stub Hacker News API ────────────────────────────────────────────────
/** 'empty' (no ids — the default) | 'ok' | 'down'. */
let hnMode = 'empty';
const hnRequests = [];
const HN_NOW_S = NOW / 1000;
// 106 is a story too: beyond top_n 5 in §15d, and the third story when the default top 30 is read.
const HN_ITEMS = {
  101: { id: 101, type: 'story', by: 'a', title: 'A room-temperature superconductor claim, examined', score: 600, time: HN_NOW_S - 3 * 3600, url: 'https://example.org/sc', descendants: 200 },
  102: { id: 102, type: 'job', by: 'b', title: 'Stub Corp is hiring physicists', score: 1, time: HN_NOW_S - 3600 },
  103: { id: 103, type: 'story', by: 'c', title: 'This story was flagged and is dead now', score: 50, time: HN_NOW_S - 3600, dead: true },
  104: { id: 104, deleted: true, type: 'story', time: HN_NOW_S - 3600 },
  105: { id: 105, type: 'story', by: 'd', title: 'Ask HN: How do tides work on a lake?', score: 30, time: HN_NOW_S - 600, descendants: 10 },
  106: { id: 106, type: 'story', by: 'e', title: 'Beyond the top 5, fetched only at the default', score: 999, time: HN_NOW_S - 3600, url: 'https://example.org/x' },
};
const hnServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  hnRequests.push(u.pathname);
  const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (hnMode === 'down') return send(500, { error: 'down' });
  if (u.pathname === '/v0/topstories.json') return send(200, hnMode === 'ok' ? [101, 102, 103, 104, 105, 106] : []);
  const m = /^\/v0\/item\/(\d+)\.json$/.exec(u.pathname);
  return send(200, m ? (HN_ITEMS[m[1]] ?? null) : null);
});
await new Promise((r) => hnServer.listen(0, '127.0.0.1', r));
const hnUrl = `http://127.0.0.1:${hnServer.address().port}`;

process.env.APP_URL ??= 'https://harness.invalid';
process.env.WEBHOOK_CALLBACK_BASE_URL ??= 'https://harness.invalid';
process.env.ALLOWED_EMAIL ??= 'harness@invalid.test';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://harness.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'harness';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { runTrends, runTrendsForAllChannels } = require(`${BUILD}/trends/run.js`);
const { startTrendsRun } = require(`${BUILD}/trends/run-now.js`);
const { latestTrendRun, sourceStatus } = require(`${BUILD}/trends/runs.js`);
const { signalsForConcepts } = require(`${BUILD}/trends/relevance.js`);
const { parseApproxTraffic } = require(`${BUILD}/drivers/trends-google.js`);
const { isArticle, WIKIPEDIA_USER_AGENT } = require(`${BUILD}/drivers/trends-wikipedia.js`);
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
const DEPS = { db, baseUrl: feedUrl, redditCredentials: CREDS, youtubeApiKey: 'harness-key', youtubeBaseUrl: ytUrl, googleTrendsBaseUrl: gtUrl, wikipediaBaseUrl: wikiUrl, hnBaseUrl: hnUrl, runKind: 'harness', now: NOW };
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
  check(ytRequests.filter((u) => u.searchParams.get('key') === 'harness-key').length >= 1 && q.sources.find((s) => s.source === 'youtube')?.failures === undefined, '  · and quota is the whole source (no per-part list), because no later call could pass it', '');
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n8b. One category with no chart is that category’s failure, not the source’s (O5)\n');
{
  // The hosted bug: category 27 answered 404 in IN and the first error ended the run, so the
  // two queries after it were never asked. Seeded inputs: 28 → [V1]; 27 → the exact 404;
  // "how fridges work" → VS; "cat physics" → 500. Expected outputs computed from those.
  ytRequests.length = 0;
  ytMode = 'chart404';
  const out = await runTrends({ channelId: B, subreddits: [], youtube: YT_CFG, googleTrends: null, wikipedia: null, hn: null }, DEPS);
  ytMode = 'ok';
  const yt = out.sources.find((s) => s.source === 'youtube');
  const asked = ytRequests.map((u) => `${u.pathname.split('/').pop()}:${u.searchParams.get('videoCategoryId') ?? u.searchParams.get('q') ?? u.searchParams.get('id')}`);
  check(
    JSON.stringify(asked) === JSON.stringify(['videos:28', 'videos:27', 'search:how fridges work', 'search:cat physics', 'videos:vidSEARCH01']),
    'every category and query was still asked after the 404, and the statistics batch for the hit that landed',
    asked.join(' '),
  );
  check(yt?.ok === true && yt.count === 2, '  · partial: ok with the 2 videos that landed (28’s and the fridge query’s)', JSON.stringify({ ok: yt?.ok, count: yt?.count }));
  const f = yt?.failures ?? [];
  check(
    f.length === 2 &&
      f[0].part === 'category 27' && f[0].kind === 'no_chart' && f[0].detail.startsWith('no most-popular chart for this category in IN (HTTP 404 notFound — Requested entity was not found.)') &&
      f[1].part === 'query “cat physics”' && f[1].kind === 'error' && f[1].detail === 'HTTP 500 backendError — Backend Error',
    '  · each failure named: category 27 has no chart in IN; the query’s 500 by its own words',
    JSON.stringify(f),
  );
  check(sourceStatus(yt) === 'partial', '  · and its status is "partial"', sourceStatus(yt));
  const rec = (await latestTrendRun(db, B));
  const recYt = rec.ok ? rec.run?.sources.find((s) => s.source === 'youtube') : null;
  check(JSON.stringify(recYt?.failures) === JSON.stringify(f), '  · the run row records the same per-part failures for /trends', JSON.stringify(recYt?.failures));

  // Every part failing is the source failing.
  ytMode = 'allfail';
  const all = await runTrends({ channelId: B, subreddits: [], youtube: YT_CFG, googleTrends: null, wikipedia: null, hn: null }, DEPS);
  ytMode = 'ok';
  const ay = all.sources.find((s) => s.source === 'youtube');
  check(ay?.ok === false && ay.count === 0 && ay.failures?.length === 4 && sourceStatus(ay) === 'failed', 'every category and query failing → the source failed, with four named parts', JSON.stringify(ay));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n16. Relevance for the channel: exact scores, each term embedded once, NULL when refused (O5)\n');
{
  // INPUTS: a stub embedder whose vectors are fixed by construction. Every niche text (the
  // bible premise, the series, the calendar topics — whatever nicheTexts returns) embeds to e0,
  // so the niche centroid IS e0 and a term's relevance is exactly its first coordinate. Terms
  // get unit vectors with known first coordinates. OUTPUT asserted: what runTrends wrote.
  const DIM = 768;
  const unit = (first) => {
    const v = new Array(DIM).fill(0);
    v[0] = first;
    v[1] = Math.sqrt(1 - first * first);
    return v;
  };
  const T_ON = 'How superconductors levitate magnets above a track';
  const T_OFF = 'Celebrity couple announces surprise wedding in Goa';
  const T_NEW = 'Why the stock market fell today, explained in charts';
  const TERM_VEC = { [T_ON]: unit(0.8125), [T_OFF]: unit(0.3) };
  const embedCalls = [];
  const stubEmbed = async (texts) => {
    embedCalls.push(texts);
    return { ok: true, model: 'harness-stub', vectors: texts.map((t) => TERM_VEC[t] ?? unit(1)) };
  };
  const refusing = async (texts) => {
    embedCalls.push(texts);
    // A refusal is only for terms; the niche is already stored, so this is never asked for it.
    return { ok: false, detail: 'embeddings vendor rate-limited (429) on all 4 attempts: stub' };
  };
  const OFF = { googleTrends: null, wikipedia: null, hn: null, youtube: null };

  listing = asListing([post(T_ON, 300, 3), post(T_OFF, 900, 3)]);
  const out = await runTrends({ channelId: A, subreddits: ['infrastructure'], ...OFF }, { ...DEPS, embedFor: () => stubEmbed });
  const rel = async (term) => (await client.query(`select relevance from trend_signals where channel_id = $1 and term = $2`, [A, term])).rows[0]?.relevance ?? 'missing';
  const on = await rel(T_ON);
  const off = await rel(T_OFF);
  // numeric crosses as a string: compared as text, exactly — no tolerance, the inputs fix it.
  check(on === '0.8125' && off === '0.3', 'relevance is the cosine with the niche, exactly: 0.8125 and 0.3', `${on}, ${off}`);
  check(out.relevance.scored === 2 && out.relevance.unscored === 0 && out.relevance.detail === null && out.relevance.nicheRebuilt === true && out.relevance.embedded === 2,
    '  · the result says 2 scored, niche built, 2 terms embedded', JSON.stringify(out.relevance));
  const niche = (await client.query(`select source_count, model, jsonb_array_length(source_texts) n from channel_niche_vectors where channel_id = $1`, [A])).rows[0];
  check(niche?.model === 'harness-stub' && niche.source_count === niche.n && niche.n >= 2, '  · the niche vector is stored with the texts it came from', JSON.stringify(niche));
  const termRows = Number((await client.query(`select count(*)::int n from trend_term_embeddings where term in ($1, $2)`, [T_ON, T_OFF])).rows[0].n);
  check(termRows === 2, '  · one stored embedding per term', String(termRows));

  // Second run, same terms: nothing new is embedded and the niche is not rebuilt.
  embedCalls.length = 0;
  const again = await runTrends({ channelId: A, subreddits: ['infrastructure'], ...OFF }, { ...DEPS, embedFor: () => stubEmbed });
  check(embedCalls.length === 0 && again.relevance.scored === 2 && again.relevance.nicheRebuilt === false, 'a term already embedded is not embedded again; the niche is read, not rebuilt', `${embedCalls.length} embed call(s)`);

  // A new term while the vendor refuses → NULL, never 0, and the reason travels.
  listing = asListing([post(T_NEW, 50, 3)]);
  embedCalls.length = 0;
  const refused = await runTrends({ channelId: A, subreddits: ['infrastructure'], ...OFF }, { ...DEPS, embedFor: () => refusing });
  const nv = (await client.query(`select relevance from trend_signals where channel_id = $1 and term = $2`, [A, T_NEW])).rows[0];
  check(nv && nv.relevance === null, 'a term the embedder refused keeps relevance NULL (not 0)', JSON.stringify(nv));
  check(refused.relevance.scored === 0 && refused.relevance.unscored === 1 && (refused.relevance.detail ?? '').startsWith('1 new term not embedded: embeddings vendor rate-limited (429)'),
    '  · and the run says why, in the vendor’s words', refused.relevance.detail);
  const rr = await latestTrendRun(db, A);
  const recorded = (await client.query(`select relevance from trend_runs where channel_id = $1 order by finished_at desc limit 1`, [A])).rows[0]?.relevance;
  check(rr.ok && recorded?.detail === refused.relevance.detail, '  · recorded on the trend_runs row for /trends', JSON.stringify(recorded));
  // No embedder at all: NULL too, and said.
  listing = asListing([post('A brand new headline no embedder will ever see', 50, 3)]);
  const bare = await runTrends({ channelId: A, subreddits: ['infrastructure'], ...OFF }, DEPS);
  check(bare.relevance.detail === 'relevance not scored: no embedder was given to this run' && bare.relevance.scored === 0, 'no embedder → not scored, said by name', bare.relevance.detail);

  // Stage 2's read: relevant first, unscored after, the off-niche one left out.
  const picked = await signalsForConcepts(db, A, 25, 0.65, NOW);
  const terms = picked.signals.map((x) => x.term);
  check(terms[0] === T_ON && !terms.includes(T_OFF) && terms.includes(T_NEW) && picked.signals[0].relevance === 0.8125 && terms.slice(1).every((t) => picked.signals.find((x) => x.term === t).relevance === null),
    'stage 2 reads the relevant signal first, then never-scored ones, and never the one measured off-niche', `${picked.basis} · ${terms.map((t) => t.slice(0, 18)).join(' | ')}`);
  const lowered = await signalsForConcepts(db, A, 25, 0.25, NOW);
  check(lowered.signals[0].term === T_ON && lowered.signals[1].term === T_OFF, '  · lower the threshold to 0.25 and the off-niche one returns, ranked by relevance', lowered.signals.slice(0, 2).map((x) => `${x.relevance}`).join(', '));
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
      await startTrendsRun(db, A, { trigger, user: { id: approverId, emailAllowed: true }, trendsFor: () => ({ subreddits: [], youtube: { region_code: 'IN', category_ids: [], queries: [] }, google_trends: null, wikipedia: null, hn: null }) }),
      `refused: Bureau of Reality's trend sources list no subreddits, no YouTube categories or queries, and turn Google Trends, Wikipedia and Hacker News off`,
    ],
  ];
  for (const [what, res, prefix] of refusals) {
    check(res.status === 'error' && (res.message ?? '').startsWith(prefix) && res.runId === undefined, `${what} is refused by name`, res.message);
  }
  check(calls.length === 1, '  · and none of those six reached trigger', `${calls.length} call(s) in total`);
  // The accepting branch: a channel whose only source is keyless Wikipedia still runs, and the
  // task receives the block exactly as configured (hn: null carried, not dropped to "default on").
  const wikiOnly = await startTrendsRun(db, A, { trigger, user: { id: approverId, emailAllowed: true }, trendsFor: () => ({ subreddits: [], youtube: null, google_trends: null, wikipedia: { languages: ['en', 'de'] }, hn: null }) });
  check(
    wikiOnly.status === 'ok' && wikiOnly.message === 'Collecting for Bureau of Reality from Wikipedia (en, de). Reload in a minute to see the signals.' && JSON.stringify(calls.at(-1)) === JSON.stringify({ channelId: A, subreddits: [], youtube: null, google_trends: null, wikipedia: { languages: ['en', 'de'] }, hn: null }),
    'Wikipedia alone is enough to run, and the task gets the block as configured (hn: null kept)',
    `${wikiOnly.message} · ${JSON.stringify(calls.at(-1))}`,
  );
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
  // Expected, computed in SQL from the rows (not from the tool): the channel's relevant rows
  // (≥ its 0.65 threshold, §16 scored one) most relevant first, then the rest by velocity,
  // nulls last. Rows of equal velocity have no defined order, so the comparison is the same
  // rows with the same sequence of (relevance band, velocity).
  const expected = (
    await client.query(
      `select term, velocity, coalesce(relevance >= 0.65, false) as rel from trend_signals where channel_id = $1 and captured_at >= now() - interval '30 days'
        order by coalesce(relevance >= 0.65, false) desc, case when relevance >= 0.65 then relevance end desc, velocity desc nulls last`,
      [A],
    )
  ).rows.map((x) => `${x.rel ? 'R' : '-'}${x.velocity === null ? '—' : Number(x.velocity)}|${x.term}`);
  const relOf = (s) => (s.relevance !== null && s.relevance >= 0.65 ? 'R' : '-');
  const got = r.ok ? r.signals.map((s) => `${relOf(s)}${s.velocity === null ? '—' : s.velocity}|${s.term}`) : [];
  const seq = (xs) => xs.map((x) => x.split('|')[0]).join();
  const terms = r.ok ? r.signals.map((s) => s.term) : [];
  check(
    r.ok === true && r.scope === 'channel' && r.scope_note === undefined && JSON.stringify([...got].sort()) === JSON.stringify([...expected].sort()) && seq(got) === seq(expected) && got[0]?.startsWith('R'),
    "A's rows only: the relevant one first, then velocity desc, nulls last",
    `${terms.length} of ${expected.length}; first ${got[0]}`,
  );
  check(r.ok && terms.at(-1) === NULL_TERM, '  · the null-velocity row is last', terms.at(-1));
  check(r.ok && r.signals.every((s) => s.velocity === null || typeof s.velocity === 'number') && r.signals.every((s) => s.volume === null || typeof s.volume === 'number'), '  · numeric columns arrive as numbers, not strings', '');

  const v1 = r.ok ? r.signals.find((s) => s.term === V1.snippet.title) : null;
  check(v1?.velocity === 5000 && v1?.volume === 50000 && v1?.url === 'https://www.youtube.com/watch?v=vidAAAAAAA1', '  · youtube link from raw.id, exact numbers', JSON.stringify(v1));
  const salt = r.ok ? r.signals.find((s) => s.term === ROAD_SALT) : null;
  check(salt?.velocity === 300 && salt?.url === `https://www.reddit.com${ROAD_SALT_LINK}`, '  · reddit link from raw.permalink', JSON.stringify(salt));

  const top = await tool.run(ctxFor(A), tool.args.parse({}));
  check(top.ok && top.signals.length === Math.min(20, expected.length) && top.signals[0].term === expected[0].split('|').slice(1).join('|'), '  · defaults: 7 days, 20 rows, highest first', `${top.ok ? top.signals.length : JSON.stringify(top)}`);

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
    last.ok && last.run?.trigger === 'harness' && recorded?.detail === r?.detail && last.run.sources.map((x) => x.source).join() === 'reddit,youtube,google_trends,wikipedia,hn',
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
console.log('\n15. Wikipedia and Hacker News: free, keyless, mapped exactly, and one failing never fails the run\n');
{
  // Seed the feeds (the stubs above), drive runTrends, assert the rows it wrote.
  const OFF = { subreddits: [], youtube: null, googleTrends: null };
  await client.query(`delete from trend_signals where source in ('wikipedia', 'hn')`);

  // a. Wikipedia: yesterday, non-articles out, views as volume, change vs the day before.
  check(
    ['Main_Page', '-', 'Special:Search', 'Spezial:Suche', 'Wikipedia:Featured_pictures', 'Wikipédia:Accueil_principal', 'File:X.jpg', 'Portal:Science'].every((t) => !isArticle(t)) &&
      ['Dune:_Part_Two', 'Superconductivity', 'Oumuamua_(interstellar_object)'].every(isArticle),
    'non-articles are filtered by namespace in any language; titles with a colon and a space stay',
  );
  wikiMode = 'ok';
  wikiRequests.length = 0;
  const w = await runTrends({ channelId: A, ...OFF, hn: null }, DEPS);
  const ws = w.sources.find((x) => x.source === 'wikipedia');
  check(ws?.ok === true && ws.count === 3 && w.inserted === 3, 'Wikipedia: 3 articles of 8 pages land (main page, Special:, "-", Wikipedia:, File: dropped)', JSON.stringify(ws));
  check(
    wikiRequests.map((r) => r.path).join() ===
      '/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/2026/08/02,/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/2026/08/01',
    '  · yesterday (UTC) for the list and the day before for the change, en by default — two calls',
    wikiRequests.map((r) => r.path).join(' '),
  );
  check(wikiRequests.every((r) => r.ua === WIKIPEDIA_USER_AGENT) && /sahil\.matt@gmail\.com/.test(WIKIPEDIA_USER_AGENT), '  · every request carries the descriptive User-Agent with contact details', wikiRequests[0]?.ua);
  const wrows = (await client.query(`select term, region, velocity, volume, raw->>'url' as url, raw->>'rank' as rank from trend_signals where source = 'wikipedia' and channel_id = $1 order by volume desc`, [A])).rows;
  check(
    JSON.stringify(wrows.map((x) => [x.term, x.region, x.velocity === null ? null : Number(x.velocity), Number(x.volume)])) ===
      JSON.stringify([['Oumuamua (interstellar object)', null, 100000, 120000], ['Dune: Part Two', null, null, 80000], ['Superconductivity', null, -15000, 60000]]),
    '  · each row exactly: title with spaces, views as volume, change as velocity (null where the day before had no reading, negative when falling)',
    JSON.stringify(wrows),
  );
  check(wrows[0]?.url === 'https://en.wikipedia.org/wiki/Oumuamua_(interstellar_object)' && wrows[0]?.rank === '4', '  · the article URL and its rank are kept in raw', `${wrows[0]?.url} · ${wrows[0]?.rank}`);

  // b. The day before unreadable: the views still land, every velocity is null, and it is said.
  wikiMode = 'noprev';
  const np = await runTrends({ channelId: A, ...OFF, hn: null }, DEPS);
  const nps = np.sources.find((x) => x.source === 'wikipedia');
  const npv = (await client.query(`select count(*)::int as n from trend_signals where source = 'wikipedia' and channel_id = $1 and velocity is not null`, [A])).rows[0].n;
  check(nps?.ok === true && nps.count === 3 && npv === 0 && (nps.detail ?? '').startsWith('velocity unavailable for en (en 2026/08/01: HTTP 404'), 'the day before missing: views land, velocity is null (absent, not zero), and the result says why', `${npv} non-null · ${nps?.detail}`);

  // c. Languages and size from the channel's config.
  wikiMode = 'ok';
  wikiRequests.length = 0;
  const de = await runTrends({ channelId: A, ...OFF, hn: null, wikipedia: { languages: ['de'], top_n: 1 } }, DEPS);
  check(de.sources.find((x) => x.source === 'wikipedia')?.count === 1 && wikiRequests[0]?.path.includes('/top/de.wikipedia/'), '  · a channel’s own languages and top_n replace the default', wikiRequests[0]?.path);

  // d. Hacker News: stories only, score as volume, score per hour as velocity, URL kept.
  hnMode = 'ok';
  hnRequests.length = 0;
  const h = await runTrends({ channelId: A, ...OFF, wikipedia: null, hn: { top_n: 5 } }, DEPS);
  const hs = h.sources.find((x) => x.source === 'hn');
  check(hs?.ok === true && hs.count === 2, 'Hacker News: of the top 5, 2 stories land (a job, a dead and a deleted item dropped)', JSON.stringify(hs));
  check(!hnRequests.includes('/v0/item/106.json') && hnRequests.filter((p) => p.startsWith('/v0/item/')).length === 5, '  · only the top N items are fetched', hnRequests.join(' '));
  const hrows = (await client.query(`select term, region, velocity, volume, raw->>'url' as url, raw->>'hn_url' as hn_url from trend_signals where source = 'hn' and channel_id = $1 order by volume desc`, [A])).rows;
  check(
    JSON.stringify(hrows.map((x) => [x.term, x.region, Number(x.velocity), Number(x.volume), x.url, x.hn_url])) ===
      JSON.stringify([
        ['A room-temperature superconductor claim, examined', null, 200, 600, 'https://example.org/sc', 'https://news.ycombinator.com/item?id=101'],
        // 10 minutes old: the one-hour floor, so 30 points reads as 30/h rather than 180/h.
        ['Ask HN: How do tides work on a lake?', null, 30, 30, null, 'https://news.ycombinator.com/item?id=105'],
      ]),
    '  · each row exactly: score as volume, score per hour as velocity (600 in 3 h = 200), URL in raw',
    JSON.stringify(hrows),
  );
  hnRequests.length = 0;
  await runTrends({ channelId: A, ...OFF, wikipedia: null }, DEPS);
  check(hnRequests.filter((p) => p.startsWith('/v0/item/')).length === 6, '  · no hn block: on by default, top 30 asked (the stub has 6)', String(hnRequests.length));

  // e. A 500 from one source is recorded by name; the other lands in the same run.
  await client.query(`delete from trend_signals where source in ('wikipedia', 'hn')`);
  wikiMode = 'down';
  const d1 = await runTrends({ channelId: A, ...OFF }, DEPS);
  const d1w = d1.sources.find((x) => x.source === 'wikipedia');
  const d1h = d1.sources.find((x) => x.source === 'hn');
  check(d1.ok && d1w?.ok === false && d1w.detail === 'en 2026/08/02: HTTP 500 — the pageviews API did not answer' && d1h?.ok === true && d1h.count === 3 && d1.inserted === 3, 'Wikipedia 500: named on the result; Hacker News (default top 30, 3 stories in the stub) in the same run lands its 3', `${d1w?.detail} · ${JSON.stringify(d1h)}`);
  const last1 = await latestTrendRun(db, A);
  const rec1 = last1.ok && last1.run ? last1.run.sources.find((x) => x.source === 'wikipedia') : null;
  check(rec1?.ok === false && rec1.detail === d1w?.detail, '  · and the trend_runs row the screen reads carries it word for word', JSON.stringify(rec1));
  wikiMode = 'ok';
  hnMode = 'down';
  await client.query(`delete from trend_signals where source in ('wikipedia', 'hn')`);
  const d2 = await runTrends({ channelId: A, ...OFF }, DEPS);
  const d2h = d2.sources.find((x) => x.source === 'hn');
  check(d2.ok && d2h?.ok === false && d2h.detail === 'topstories: HTTP 500' && d2.sources.find((x) => x.source === 'wikipedia')?.count === 3 && d2.inserted === 3, 'Hacker News 500: named on the result; Wikipedia in the same run lands its 3', `${d2h?.detail} · inserted ${d2.inserted}`);

  // f. Turned off by name; and neither writes a cost row.
  const off = await runTrends({ channelId: A, ...OFF, wikipedia: null, hn: null }, DEPS);
  check(
    off.sources.find((x) => x.source === 'wikipedia')?.detail === 'not configured: this channel’s trend sources turn Wikipedia off (wikipedia: null)' &&
      off.sources.find((x) => x.source === 'hn')?.detail === 'not configured: this channel’s trend sources turn Hacker News off (hn: null)',
    'wikipedia: null / hn: null say so, by the field that turned each off',
  );
  const ledger = Number((await client.query(`select count(*)::int as n from cost_ledger`)).rows[0].n);
  check(ledger === 0, 'no cost_ledger rows: both are free and keyless', String(ledger));

  wikiMode = 'empty';
  hnMode = 'empty';
  // §12 orders by velocity, and Wikipedia rows can be null: removed for the same reason as Google's.
  await client.query(`delete from trend_signals where source in ('wikipedia', 'hn')`);
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
    await client.query(`select term, velocity from trend_signals where captured_at >= now() - interval '30 days' order by velocity desc nulls last`)
  ).rows.map((x) => `${x.velocity === null ? '—' : Number(x.velocity)}|${x.term}`);
  const got = r.ok ? r.signals.map((s) => `${s.velocity === null ? '—' : s.velocity}|${s.term}`) : [];
  // Rows of equal velocity have no defined order (in Postgres or in the tool), so the
  // comparison is: the same rows, and the velocities in the same sequence. Comparing terms
  // in order broke the first time an update moved two equal-velocity rows in the heap.
  const vel = (xs) => xs.map((x) => x.split('|')[0]).join();
  check(
    r.ok === true && r.scope === 'workspace' && (r.scope_note ?? '').startsWith('migration 0046 not applied') && JSON.stringify([...got].sort()) === JSON.stringify([...all].sort()) && vel(got) === vel(all),
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
wikiServer.close();
hnServer.close();
await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nStage 1 collects per channel, deduplicates, refuses by name and reports what it could not reach.\n' +
    'What is left: a real run against the real feeds with a real key, which only a deploy can do.\n',
);
