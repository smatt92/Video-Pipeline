#!/usr/bin/env node
/**
 * Stage 11 — measurement, against a real database.
 *
 * PROVES:  a blank retention field stays null and never becomes 0; a failed read lands as a
 *          row that carries no numbers and a reason; a measured row without views is
 *          refused rather than stored; the due list is computed from the clock and shows
 *          three coverage states rather than two; a hook shape's median is over the videos
 *          that actually had retention, not over the ones that were measured; a video whose
 *          hook never classified is absent from the rollup AND visible in the view that
 *          exists to say so; cost per 1k is null with a stated reason on an unpriced video
 *          and a real figure on a priced one; and `compileShot` never ranks a ship rate
 *          against a retention score.
 *
 * ── What makes the assertions here evidence rather than tautology ────────────
 *
 * Every assertion is about what the code under test *returned* or what the *database*
 * computed, never about a row this file seeded. `seedScript` writes `hook_pattern`, so an
 * assertion reading `scripts.hook_pattern` back would pass whatever `classifyHook` did —
 * CLAUDE.md's second surface of the independent-routes rule, and it is exactly the mistake
 * available here. So `classifyHook` is called directly and its return value asserted, and
 * the rollups are asserted against views the harness does not write.
 *
 * Section 6 is LOAD-BEARING. It is the only place where the producer and the consumer are
 * checked against each other: the form-level refusal in `recordSnapshot` and the CHECK
 * constraint in migration 0034 must refuse the same states, and a harness that drove only
 * one of them would leave the other claiming a protection it might not have.
 *
 * Usage: node scripts/verify-measure.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-measure.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { recordSnapshot } = require(`${BUILD}/measure/snapshot.js`);
const { readMeasureBoard } = require(`${BUILD}/measure/read.js`);
const { classifyHook, HOOK_PATTERN_VERSION } = require(`${BUILD}/measure/hook-pattern.js`);
const { compileShot } = require(`${BUILD}/shots/compile.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => { console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const eq = (l, actual, expected) =>
  actual === expected ? ok(l, String(actual)) : bad(l, `expected ${expected}, got ${actual}`);
const isNull = (l, v) => (v === null ? ok(l, 'null') : bad(l, `expected null, got ${JSON.stringify(v)}`));

const scratch = await scratchDatabase(dbUrl, 'measure');
const client = scratch.client;
const db = supabaseShim(client);
const q = (sql, params = []) => client.query(sql, params);

console.log('\nStage 11 — measurement\n');

// ═══════════════════════════════════════════════════════════════════════════════
console.log('0. The classifier, driven directly\n');
// Asserted against what `classifyHook` RETURNS, not against a column the fixtures below
// write. The column is written by production too, which is what would make the wrong
// version of this assertion look right.
{
  eq('a figure wins over the question mark', classifyHook('Why do 90% of these fail?'), 'number_claim');
  eq('a received view denied', classifyHook('Everyone thinks this is the hard part'), 'contradiction');
  eq('a cost of not watching', classifyHook('Stop doing this to your footage'), 'warning');
  eq('shows first', classifyHook('Watch what happens at four seconds'), 'demonstration');
  eq('mid-scene', classifyHook('Last week I deleted the whole project'), 'story_open');
  eq('opens by asking', classifyHook('How long should a hook be'), 'question');
  // "actually" and "but" are contradiction markers only at the start of a hook. Mid
  // sentence they are filler, and the first draft of this classifier read
  // "How long should a hook actually be" as a contradiction — a question, misfiled by a
  // word doing no work. Anchoring them is the fix; loosening the assertion would have been
  // the wrong one.
  eq('a mid-sentence "actually" is filler, not a contradiction',
     classifyHook('How long should a hook actually be'), 'question');
  eq('at the start it is a contradiction', classifyHook('Actually the lens is the problem'), 'contradiction');
  eq('names the viewer', classifyHook('Your camera is already doing this'), 'direct_address');

  // Null, and no residual bucket. The whole reason `hook_pattern` is nullable.
  isNull('an unrecognised shape classifies to null, not to "other"', classifyHook('Kiln. Ceramic.'));
  isNull('an empty hook classifies to null', classifyHook('   '));
}

// ── Fixtures ───────────────────────────────────────────────────────────────────
const channelId = randomUUID();
await q(
  `insert into channels (id, name, platform, handle, niche)
   values ($1,'Kiln test','youtube','@kiln','test')`,
  [channelId],
);

/**
 * A publication that went live `agoHours` ago.
 *
 * Seeds inputs — a concept, a script, a render, a passed review, a publication. Asserts
 * nothing about them; everything asserted below is computed by a view or returned by a
 * function in src/.
 */
async function seedPublication({ title, hook, agoHours, hookPattern, classified = true }) {
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  const renderId = randomUUID();
  const reviewId = randomUUID();
  const pubId = randomUUID();

  await q(
    `insert into concepts (id, channel_id, title, angle, rubric_version)
     values ($1,$2,$3,'an angle','v1')`,
    [conceptId, channelId, title],
  );
  await q(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash,
                          hook_pattern, hook_pattern_version, human_edit_count)
     values ($1,$2,$3,'[]'::jsonb,'some words','claude-opus-5',$4,$5,$6,1)`,
    [scriptId, conceptId, hook, randomUUID(), hookPattern,
     classified ? HOOK_PATTERN_VERSION : null],
  );
  await q(
    `insert into renders (id, script_id, variant_group_id, variant_label, format, width, height, status)
     values ($1,$2,$3,'hook-a','shorts_9x16',1080,1920,'ready')`,
    [renderId, scriptId, randomUUID()],
  );
  await q(
    `insert into reviews (id, render_id, reviewer_id, decision, human_edit_count, structure_novel)
     values ($1,$2,$3,'pass',1,true)`,
    [reviewId, renderId, randomUUID()],
  );
  await q(
    `insert into publications (id, render_id, channel_id, review_id, title, status, published_at)
     values ($1,$2,$3,$4,$5,'live', now() - ($6 || ' hours')::interval)`,
    [pubId, renderId, channelId, reviewId, title, String(agoHours)],
  );
  return { conceptId, scriptId, renderId, pubId };
}

const ledger = (cols) => {
  const keys = Object.keys(cols);
  return q(
    `insert into cost_ledger (${keys.join(',')}) values (${keys.map((_, i) => `$${i + 1}`).join(',')})`,
    keys.map((k) => cols[k]),
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n1. Nothing published — the screen is empty, not zero\n');
{
  const board = await readMeasureBoard(db);
  eq('no reads failed', board.unreadable.length, 0);
  eq('no live publications', board.publicationsLive, 0);
  eq('nothing is due', board.due.length, 0);
  eq('no coverage rows', board.coverage.length, 0);
  eq('no hook rows', board.hooks.length, 0);
  // The inverse test, stated as an assertion rather than as a hope: with nothing published
  // the board must be empty in EVERY dimension. A screen that renders the same at one video
  // and at a hundred fails here first, before it can be built.
  eq('no cost-per-1k rows', board.costPerK.length, 0);
  // The undefined case, at the only level it can occur. `readMeasureBoard` returns no
  // coverage rows, so the screen's total due is 0 and its share is undefined rather than
  // 0% — "0% measured" would accuse an operator of neglecting work that does not exist.
  eq('nothing is due, so the share has no denominator',
     board.coverage.reduce((n, c) => n + c.due, 0), 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n2. Due is computed from the clock, and has three states\n');
const week = await seedPublication({
  title: 'Nine days old', hook: 'Why do 90% of these fail?', agoHours: 24 * 9,
  hookPattern: 'number_claim',
});
const fresh = await seedPublication({
  title: 'One hour old', hook: 'Your camera is already doing this', agoHours: 1,
  hookPattern: 'direct_address',
});
{
  const board = await readMeasureBoard(db);
  eq('both are live', board.publicationsLive, 2);

  const forWeek = board.due.filter((d) => d.publicationId === week.pubId);
  const forFresh = board.due.filter((d) => d.publicationId === fresh.pubId);

  // Nine days: 6h, 24h and 7d have passed; 30d has not. Asserted as the exact set rather
  // than as a count, because "3" would survive the wrong three.
  eq('nine days old is due for three buckets', forWeek.length, 3);
  eq(
    'and they are the three whose clock has passed',
    forWeek.map((d) => d.ageBucket).sort().join(','),
    '24h,6h,7d',
  );
  // The fresh one is live and due for nothing. This is the row that makes `publicationsLive`
  // an independent route: derived from the due list it would have been 1, not 2.
  eq('one hour old is due for nothing', forFresh.length, 0);
  eq('all three are outstanding', forWeek.filter((d) => d.coverageState === 'outstanding').length, 3);

  const cov = board.coverage.find((c) => c.channelId === channelId);
  eq('coverage counts what is due', cov.due, 3);
  eq('and nothing captured', cov.captured, 0);
  // 0, not null: something IS due and none of it has been read, which is a real ratio and
  // a real complaint. The undefined case — nothing due at all — cannot occur in this view
  // (a channel appears only once it has a due row) and is asserted in section 1 against
  // the board, which is the level where the denominator can genuinely be empty.
  eq('captured_share is 0 because something IS due', cov.capturedShare, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n3. A blank retention field stays blank\n');
{
  // Exactly what the form sends when a person types views and leaves retention alone.
  // Empty strings, not nulls — `Number('')` is 0, and that coercion is the entire subject
  // of this section.
  const result = await recordSnapshot(db, {
    status: 'measured',
    publicationId: week.pubId,
    ageBucket: '7d',
    metricSource: 'manual_entry',
    views: '4210',
    likes: '',
    comments: '',
    shares: '',
    saves: '',
    avgViewPct: '',
    retention3sPct: '',
  });
  eq('the snapshot was recorded', result.ok, true);

  const { rows } = await q(
    `select views, likes, retention_3s_pct, avg_view_pct, metric_source, status
       from metrics_snapshots where publication_id = $1 and age_bucket = '7d'`,
    [week.pubId],
  );
  eq('views round-tripped', Number(rows[0].views), 4210);
  // The assertion this section exists for. `0` here would be a claim that nobody made it
  // past three seconds — the strongest statement this table can make about a hook —
  // invented by an HTML input nobody touched.
  isNull('a blank retention field is null, not 0', rows[0].retention_3s_pct);
  isNull('a blank likes field is null, not 0', rows[0].likes);
  isNull('a blank avg view % is null, not 0', rows[0].avg_view_pct);
  eq('and the row records that a person typed it', rows[0].metric_source, 'manual_entry');
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n4. A failed read is a row, and it carries nothing\n');
{
  const result = await recordSnapshot(db, {
    status: 'unavailable',
    publicationId: week.pubId,
    ageBucket: '24h',
    metricSource: 'manual_entry',
    unavailableReason: 'Studio withholds retention below 100 views',
  });
  eq('the unavailable bucket was recorded', result.ok, true);

  const board = await readMeasureBoard(db);
  const row = board.due.find((d) => d.publicationId === week.pubId && d.ageBucket === '24h');
  // Three states, not two. A null-check on the snapshot id cannot tell these apart, and
  // they mean opposite things: one is work outstanding, the other is work finished.
  eq('it reads back as unavailable, not as outstanding', row.coverageState, 'unavailable');
  isNull('and carries no views', row.views);

  const cov = board.coverage.find((c) => c.channelId === channelId);
  eq('coverage counts it apart from captured', cov.unavailable, 1);
  eq('captured is only the measured one', cov.captured, 1);
  eq('and one bucket is still outstanding', cov.outstanding, 1);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n5. A reason is required, and a measured row needs its denominator\n');
{
  const noReason = await recordSnapshot(db, {
    status: 'unavailable', publicationId: week.pubId, ageBucket: '6h',
    metricSource: 'manual_entry', unavailableReason: '   ',
  });
  eq('unavailable with no reason is refused', noReason.ok, false);
  eq('and says why', noReason.code, 'invalid_input');

  const noViews = await recordSnapshot(db, {
    status: 'measured', publicationId: week.pubId, ageBucket: '6h',
    metricSource: 'manual_entry',
    views: '', likes: '12', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '41',
  });
  eq('measured with no views is refused', noViews.ok, false);
  eq('and names the denominator', noViews.code, 'measured_without_views');

  // The refusal must not have written anything. A guard that refuses and stores is worse
  // than one that does neither, because the row looks like a decision somebody made.
  const { rows } = await q(
    `select count(*)::int as n from metrics_snapshots where publication_id = $1 and age_bucket = '6h'`,
    [week.pubId],
  );
  eq('and nothing was stored', rows[0].n, 0);

  const outOfRange = await recordSnapshot(db, {
    status: 'measured', publicationId: week.pubId, ageBucket: '6h',
    metricSource: 'manual_entry',
    views: '100', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '0.41',
  });
  // 0.41 is a vendor's 0–1 ratio typed into a 0–100 field. It is *in range*, so this
  // passes — and that is the finding, not a bug in the harness: the schema cannot catch a
  // ratio that looks like a percentage. What it can catch is one outside the range.
  eq('a 0–1 ratio in a 0–100 field is accepted, and that is a known limit', outOfRange.ok, true);
  const tooBig = await recordSnapshot(db, {
    status: 'measured', publicationId: fresh.pubId, ageBucket: '6h',
    metricSource: 'manual_entry',
    views: '10', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '410',
  });
  eq('but 410% is refused', tooBig.ok, false);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n6. LOAD-BEARING — the function and the CHECK refuse the same states\n');
// Why this is the load-bearing section, said here rather than left to be inferred.
//
// `recordSnapshot` refuses a measured row with no views, and migration 0034's CHECK
// refuses the same. Those are two independent implementations of one rule, written from
// the same understanding of the world — which is exactly the shape CLAUDE.md warns produces
// an assertion that can only fail on a typo. The two are only evidence when each is driven
// on its own: section 5 drove the function, and this drives the constraint directly, past
// the function, in SQL the function never sees.
//
// If this ever passes while section 5 fails, the guard moved out of the database. If it
// fails while section 5 passes, the application is the only thing standing between a
// fabricated measurement and the table everything derives from.
{
  const attempts = [
    ['a measured row with no views', `insert into metrics_snapshots (publication_id, age_bucket, status, views) values ($1,'30d','measured',null)`],
    ['an unavailable row carrying views', `insert into metrics_snapshots (publication_id, age_bucket, status, unavailable_reason, views) values ($1,'30d','unavailable','nope',5)`],
    ['an unavailable row with no reason', `insert into metrics_snapshots (publication_id, age_bucket, status) values ($1,'30d','unavailable')`],
    ['a negative view count', `insert into metrics_snapshots (publication_id, age_bucket, status, views) values ($1,'30d','measured',-1)`],
    ['retention above 100', `insert into metrics_snapshots (publication_id, age_bucket, status, views, retention_3s_pct) values ($1,'30d','measured',1,101)`],
  ];
  for (const [label, sql] of attempts) {
    try {
      await q(sql, [week.pubId]);
      bad(`the database refuses ${label}`, 'it was accepted');
    } catch (err) {
      if (/violates check constraint/i.test(err.message)) ok(`the database refuses ${label}`);
      else bad(`the database refuses ${label}`, err.message);
    }
  }
  // And the accepting branch, because a guard whose test only exercises the refusal passes
  // on an empty database whatever the accept branch does.
  await q(
    `insert into metrics_snapshots (publication_id, age_bucket, status, views, retention_3s_pct)
     values ($1,'30d','measured',1,100)`,
    [week.pubId],
  );
  ok('and accepts a measured row at exactly 100%');
  await q(`delete from metrics_snapshots where publication_id = $1 and age_bucket = '30d'`, [week.pubId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n7. Replay: the same bucket, looked at again\n');
{
  const before = await q(
    `select captured_at, updated_at from metrics_snapshots where publication_id = $1 and age_bucket = '24h'`,
    [week.pubId],
  );
  const result = await recordSnapshot(db, {
    status: 'measured', publicationId: week.pubId, ageBucket: '24h',
    metricSource: 'manual_entry',
    views: '900', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '38',
  });
  eq('the re-read replaced rather than failed', result.ok && result.replaced, true);

  const after = await q(
    `select captured_at, updated_at, status, unavailable_reason, views
       from metrics_snapshots where publication_id = $1 and age_bucket = '24h'`,
    [week.pubId],
  );
  eq('it is now measured', after.rows[0].status, 'measured');
  eq('with the new figure', Number(after.rows[0].views), 900);
  // The reason must be cleared, not left beside a status that contradicts it. An UPDATE
  // that omitted the column would leave it, and the row would carry an explanation for an
  // absence that is no longer absent.
  isNull('and the stale unavailable reason is gone', after.rows[0].unavailable_reason);
  eq(
    'captured_at is preserved — first look and latest look are different facts',
    after.rows[0].captured_at.toISOString(),
    before.rows[0].captured_at.toISOString(),
  );
  if (after.rows[0].updated_at > before.rows[0].updated_at) ok('and updated_at moved');
  else bad('and updated_at moved', 'it did not');
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n8. A snapshot belongs to something published\n');
{
  const draftPubId = randomUUID();
  const d = await seedPublication({
    title: 'Never went live', hook: 'How long should a hook be', agoHours: 48,
    hookPattern: 'question',
  });
  await q(`update publications set status='draft', published_at=null where id=$1`, [d.pubId]);

  const result = await recordSnapshot(db, {
    status: 'measured', publicationId: d.pubId, ageBucket: '6h',
    metricSource: 'manual_entry',
    views: '10', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '',
  });
  eq('an unpublished video cannot be measured', result.ok, false);
  eq('and the code says why', result.code, 'not_published');

  const missing = await recordSnapshot(db, {
    status: 'measured', publicationId: draftPubId, ageBucket: '6h',
    metricSource: 'manual_entry',
    views: '10', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '',
  });
  eq('and a publication that does not exist is refused too', missing.code, 'no_such_publication');

  await q(`delete from publications where id=$1`, [d.pubId]);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n9. Hook rollup — and the videos it cannot see\n');
{
  // Three more videos of one shape, so a median is over something. Two get retention, one
  // is measured without it — which is the normal case at low view counts and the reason
  // videos_with_retention is a separate column.
  const shapes = [
    { title: 'Q one', hook: 'Why do 90% of these fail?', retention: '30' },
    { title: 'Q two', hook: 'Why do 90% of these fail?', retention: '50' },
    { title: 'Q three', hook: 'Why do 90% of these fail?', retention: '' },
  ];
  for (const s of shapes) {
    const p = await seedPublication({
      title: s.title, hook: s.hook, agoHours: 24 * 9, hookPattern: 'number_claim',
    });
    await recordSnapshot(db, {
      status: 'measured', publicationId: p.pubId, ageBucket: '7d',
      metricSource: 'manual_entry',
      views: '1000', likes: '', comments: '', shares: '', saves: '',
      avgViewPct: '', retention3sPct: s.retention,
    });
  }

  const board = await readMeasureBoard(db);
  const numberClaim = board.hooks.find((h) => h.hookPattern === 'number_claim');
  // Four videos of this shape are measured; the fifth section's `week` video was measured
  // with a blank retention too, so five measured and three with a number.
  eq('four videos of this shape are measured', numberClaim.videosMeasured, 4);
  eq('two of them carry a retention figure', numberClaim.videosWithRetention, 2);
  // The median is over the two that HAVE a number, not over the four that were measured.
  // Dividing by videosMeasured would give 20, which is a real-looking figure produced by
  // counting an absence as a zero.
  eq('and the median is over those two', Number(numberClaim.medianRetention3sPct), 40);
  eq('worst', Number(numberClaim.worstRetention3sPct), 30);
  eq('best', Number(numberClaim.bestRetention3sPct), 50);

  // ── The rollup's blind spot ─────────────────────────────────────────────────
  const blind = await seedPublication({
    title: 'Unclassifiable', hook: 'Kiln. Ceramic.', agoHours: 24 * 9,
    hookPattern: null, classified: true,
  });
  await recordSnapshot(db, {
    status: 'measured', publicationId: blind.pubId, ageBucket: '7d',
    metricSource: 'manual_entry',
    views: '9999', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '95',
  });

  const after = await readMeasureBoard(db);
  const sumInRollup = after.hooks.reduce((n, h) => n + h.videosMeasured, 0);
  const measuredAt7d = after.due.filter((d) => d.ageBucket === '7d' && d.coverageState === 'captured').length;

  // The assertion that matters: a 95% retention video is measured, is counted in coverage,
  // and appears in NO row of the rollup. Nothing in `hooks` can reveal that — which is why
  // the number below has to come from a different view.
  if (sumInRollup < measuredAt7d) ok('a measured video is missing from every rollup row', `${sumInRollup} of ${measuredAt7d}`);
  else bad('a measured video is missing from every rollup row', `${sumInRollup} vs ${measuredAt7d}`);
  eq('and the view that exists to say so, says so', after.unclassifiedHooks, 1);
  eq('classified and unrecognised, not a backfill', after.neverClassifiedHooks, 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n10. Cost per 1k — and why there is no number when there is none\n');
{
  // An unpriced charge on a measured video. The figure must be null, and the reason must
  // say cost rather than measurement — the two send you to different screens.
  await ledger({
    script_id: week.scriptId, driver: 'testdriver', quantity: 1, unit: 'clip',
    cost_usd: 0.5, cost_inr: null, entry_kind: 'reconcile',
  });
  const board = await readMeasureBoard(db);
  const row = board.costPerK.find((r) => r.publicationId === week.pubId);
  isNull('an unpriced video has no per-1k figure', row.costPer1kInr);
  eq('and the reason names the cost, not the measurement', row.state, 'cost_unknown');

  // Now a fully priced one.
  const priced = await seedPublication({
    title: 'Priced', hook: 'Stop doing this to your footage', agoHours: 24 * 9,
    hookPattern: 'warning',
  });
  await ledger({
    script_id: priced.scriptId, driver: 'anthropic', quantity: 1000, unit: 'input_token',
    cost_usd: 1, cost_inr: 88.5, entry_kind: 'reconcile',
  });
  await recordSnapshot(db, {
    status: 'measured', publicationId: priced.pubId, ageBucket: '7d',
    metricSource: 'manual_entry',
    views: '10000', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '44',
  });

  const after = await readMeasureBoard(db);
  const p = after.costPerK.find((r) => r.publicationId === priced.pubId);
  eq('a priced, measured video is countable', p.state, 'countable');
  // ₹88.50 over 10,000 views = ₹8.85 per 1,000. Asserted against the arithmetic rather
  // than against "> 0" — a ledger row truncated to a tenth of its real cost satisfies
  // "> 0" and is exactly the failure that assertion shape has hidden here before.
  eq('and the figure is the arithmetic', Number(p.costPer1kInr), 8.85);
  // `rate_card` is cost_ledger's default, so this figure is priced by us rather than by a
  // vendor, and the column has to say so. Getting `measured` here would mean the screen
  // could present an estimate as an invoice.
  eq('the basis says rate card, because that is what the row was', p.costBasis, 'estimated');

  // And the other branch, driven rather than assumed. A basis column whose only exercised
  // value is the default is a column that has never been shown to distinguish anything.
  const both = await seedPublication({
    title: 'Part measured', hook: 'Watch what happens at four seconds', agoHours: 24 * 9,
    hookPattern: 'demonstration',
  });
  await ledger({
    script_id: both.scriptId, driver: 'testdriver', quantity: 1, unit: 'clip',
    cost_usd: 1, cost_inr: 50, entry_kind: 'reconcile', cost_source: 'measured',
  });
  await recordSnapshot(db, {
    status: 'measured', publicationId: both.pubId, ageBucket: '7d',
    metricSource: 'manual_entry',
    views: '5000', likes: '', comments: '', shares: '', saves: '',
    avgViewPct: '', retention3sPct: '',
  });
  const m = (await readMeasureBoard(db)).costPerK.find((r) => r.publicationId === both.pubId);
  eq('a wholly measured video says measured', m.costBasis, 'measured');
  eq('and divides the same way', Number(m.costPer1kInr), 10);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n11. compileShot never ranks a ship rate against a retention score\n');
{
  const base = {
    driver: 'testdriver', model: 'm', template: 'a {{description}}', params: {},
    tags: ['establishing'], isActive: true, timesCompiled: 0, lastCompiledAt: null,
    acceptsCharacterRef: false,
  };
  const shot = {
    description: 'a wide', intent: 'open', durationS: 3, shotKind: 'establishing',
    characterId: null,
  };

  // One recipe has an outcome, the other only editorial survival. Ranking across the two
  // would put the 0.80 ship rate first on a number that means something else entirely.
  const mixed = [
    { ...base, id: 'a', name: 'measured', version: 1, shipRate: 0.10, retentionScore: 0.35 },
    { ...base, id: 'b', name: 'shipped-only', version: 1, shipRate: 0.80, retentionScore: null },
  ];
  const m = compileShot(shot, mixed, 'testdriver');
  eq('a mixed set ranks on ship rate', m.resolved, true);
  eq('so the 0.80 ship rate wins', m.compiledParams.prompt_name, 'shipped-only');
  if (/ship rate 80%/.test(m.note)) ok('and the note names the basis it used');
  else bad('and the note names the basis it used', m.note);

  // Give both an outcome and the basis flips — to the LOWER ship rate, which is the whole
  // point: the loop is meant to find the shot that survives review and loses the audience.
  const bothMeasured = [
    { ...base, id: 'a', name: 'measured', version: 1, shipRate: 0.10, retentionScore: 0.55 },
    { ...base, id: 'b', name: 'shipped-only', version: 1, shipRate: 0.80, retentionScore: 0.20 },
  ];
  const b = compileShot(shot, bothMeasured, 'testdriver');
  eq('once every recipe has an outcome, retention decides', b.compiledParams.prompt_name, 'measured');
  if (/3s retention 55%/.test(b.note)) ok('and the note says which number decided');
  else bad('and the note says which number decided', b.note);
}

// ═══════════════════════════════════════════════════════════════════════════════
await scratch.release();

console.log(`\n${failures === 0 ? 'Measurement is a set of rows with a stated denominator.' : `${failures} failure(s).`}\n`);
process.exit(failures === 0 ? 0 : 1);
