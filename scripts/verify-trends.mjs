#!/usr/bin/env node
/**
 * Stage 1 — trend intake, against real Postgres and a real HTTP feed.
 *
 * PROVES:  signals land with their raw payload kept; the velocity proxy is computed from
 *          score and age rather than copied; the same term twice in a day updates rather
 *          than duplicating, and keeps the *later* reading; a malformed listing is skipped
 *          without failing the run; a source that is down does not take the others with it;
 *          the unimplemented sources refuse explicitly rather than returning empty; and no
 *          `cost_ledger` row is written, because nothing here costs money.
 *
 * DOES NOT: prove the real feeds return this shape. They are public and unversioned, and
 *           that is the standing risk with this stage rather than a gap in the harness.
 *
 * Usage: node scripts/verify-trends.mjs <db-url>
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-trends.mjs <db-url>');
  process.exit(2);
}

// ── The stub feed ───────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
let listing = null;
let hits = 0;

const feed = createServer((req, res) => {
  hits++;
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

process.env.APP_URL ??= 'https://harness.invalid';
process.env.WEBHOOK_CALLBACK_BASE_URL ??= 'https://harness.invalid';
process.env.ALLOWED_EMAIL ??= 'harness@invalid.test';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://harness.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'harness';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';
process.env.USD_INR_RATE ??= '88.5';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { runTrends } = require(`${BUILD}/trends/run.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const scratch = await scratchDatabase(dbUrl, 'trends');
const client = scratch.client;
const db = supabaseShim(client);

const post = (title, score, hoursOld) => ({
  data: {
    title,
    score,
    created_utc: NOW / 1000 - hoursOld * 3600,
    num_comments: 12,
    subreddit: 'infrastructure',
  },
});
const asListing = (posts) => ({ data: { children: posts } });

const DEPS = { db, baseUrl: feedUrl, now: NOW };

console.log('\nStage 1 — trend intake\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. Signals land, with the reading and the raw payload\n');
{
  listing = asListing([
    post('Road salt is dissolving bridge decks faster than expected', 500, 2),
    post('The winter maintenance budget problem nobody talks about', 100, 20),
    post('short', 900, 1),
  ]);

  const out = await runTrends({ subreddits: ['infrastructure'] }, DEPS);

  if (out.inserted === 2) ok('two of three land', 'the third is under the term-length floor');
  else bad('two of three land', JSON.stringify(out.sources));

  const { rows } = await client.query(
    `select term, velocity, volume, raw->>'subreddit' as sub
       from trend_signals order by velocity desc`,
  );

  // 500 points in 2 hours is 250/h; 100 in 20 hours is 5/h. The ordering is the whole
  // point of the proxy — a fast small post beats a slow big one.
  if (rows[0]?.velocity === '250' || Number(rows[0]?.velocity) === 250) {
    ok('  · velocity is score over age', `${rows[0].velocity}/h from 500 points in 2h`);
  } else {
    bad('  · velocity is score over age', JSON.stringify(rows[0]));
  }

  if (Number(rows[1]?.velocity) === 5) ok('  · and a slower post ranks below', '5/h');
  else bad('  · and a slower post ranks below', JSON.stringify(rows[1]));

  if (rows[0]?.sub === 'infrastructure') {
    ok('  · with the untouched payload kept', "raw->>'subreddit'");
  } else {
    bad('  · with the untouched payload kept', JSON.stringify(rows[0]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. The same term twice in a day updates, and keeps the later reading\n');
{
  // Four cron runs a day, and the same post is hot all afternoon. Without this the table
  // fills with one subreddit's afternoon and stage 2 scores that instead of a week.
  listing = asListing([
    post('Road salt is dissolving bridge decks faster than expected', 1200, 4),
  ]);

  const before = (await client.query(`select count(*)::int as n from trend_signals`)).rows[0].n;
  const out = await runTrends({ subreddits: ['infrastructure'] }, DEPS);
  const after = (await client.query(`select count(*)::int as n from trend_signals`)).rows[0].n;

  if (after === before && out.updated === 1) ok('no new row', `${out.updated} updated`);
  else bad('no new row', `${before} → ${after}, updated ${out.updated}`);

  const { rows } = await client.query(
    `select velocity, volume from trend_signals where term like 'Road salt%'`,
  );
  // 1200 over 4 hours is 300/h, up from 250. The newer measurement must win.
  if (Number(rows[0]?.velocity) === 300 && Number(rows[0]?.volume) === 1200) {
    ok('  · and the newer reading replaced the older', '250/h → 300/h');
  } else {
    bad('  · and the newer reading replaced the older', JSON.stringify(rows[0]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. A bad feed is one source failing, not a failed run\n');
{
  listing = 'garbage';
  const garbage = await runTrends({ subreddits: ['infrastructure'] }, DEPS);
  if (garbage.ok && garbage.inserted === 0) {
    ok('a malformed listing is skipped', 'the run still returns ok');
  } else {
    bad('a malformed listing is skipped', JSON.stringify(garbage));
  }

  listing = 'down';
  const down = await runTrends({ subreddits: ['infrastructure'] }, DEPS);
  const reddit = down.sources.find((s) => s.source === 'reddit');
  if (down.ok && reddit && !reddit.ok && /503/.test(reddit.detail ?? '')) {
    ok('a source that is down is reported', reddit.detail);
  } else {
    bad('a source that is down is reported', JSON.stringify(down.sources));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. The unbuilt sources refuse rather than returning nothing\n');
{
  listing = asListing([]);
  const out = await runTrends({ subreddits: [] }, DEPS);

  const yt = out.sources.find((s) => s.source === 'youtube');
  const gt = out.sources.find((s) => s.source === 'google_trends');

  // An empty list from a source nobody wrote is indistinguishable from a quiet day, and
  // that is the failure mode this is avoiding: stage 2 would score a third of the world
  // while everything looked green.
  if (yt && !yt.ok && /not implemented/.test(yt.detail ?? '')) {
    ok('youtube says it is not implemented', yt.detail);
  } else {
    bad('youtube says it is not implemented', JSON.stringify(yt));
  }

  if (gt && !gt.ok && /not implemented/.test(gt.detail ?? '')) {
    ok('google_trends says the same', gt.detail);
  } else {
    bad('google_trends says the same', JSON.stringify(gt));
  }

  // No subreddits means no request at all, rather than a request to a default.
  const before = hits;
  await runTrends({ subreddits: [] }, DEPS);
  if (hits === before) ok('  · and an empty subreddit list fetches nothing', 'no default feed');
  else bad('  · and an empty subreddit list fetches nothing', `${hits - before} request(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. Nothing here costs money\n');
{
  const { rows } = await client.query(
    `select count(*)::int as n from cost_ledger where stage = '01-trends'`,
  );
  // Asserted rather than assumed. Rule 5 is otherwise absolute, and this is the one stage
  // where a missing ledger row is correct — so the absence is checked, not left to a
  // reader's confidence that it was deliberate.
  if (rows[0].n === 0) ok('no cost_ledger rows', 'public feeds, no credential, no charge');
  else bad('no cost_ledger rows', `${rows[0].n} rows`);
}

feed.close();
await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nStage 1 collects, deduplicates and reports what it could not reach.\n' +
    'What is left: whether the real feeds still return this shape, which is unversioned\n' +
    'and can change without notice.\n',
);
