#!/usr/bin/env node
/**
 * Vendor limits and the credit clock, against a real database.
 *
 * PROVES:  an unknown ceiling stays unknown; a fallback is never presented as a reading;
 *          "never submitted" is distinguished from "never limited"; concurrency and rate
 *          refusals are counted apart; the credit clock is exact; and a purchase total is
 *          never presented as a balance while nothing records consumption.
 *
 * WHY EACH FIGURE IS THE ONE IT IS
 *
 * Both blocks this covers are the two most tempting places in the app to render a
 * fabricated number, because the natural shape of each — usage over ceiling, credits
 * remaining — needs a numerator that does not exist. The assertions below are mostly about
 * what must NOT appear.
 *
 * Usage: node scripts/verify-limits.mjs <db-url>
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error('usage: node scripts/verify-limits.mjs <db-url>'); process.exit(2); }

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { readLimits, soonestExpiry, QUOTAS } = require(`${BUILD}/pipeline/limits.js`);
const { readObservability, WITHHELD } = require(`${BUILD}/pipeline/observability.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => { console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`); failures += 1; };
const eq = (l, a, e) => (a === e ? ok(l, String(a)) : bad(l, `expected ${e}, got ${a}`));

const scratch = await scratchDatabase(dbUrl, 'limits');
const client = scratch.client;
const db = supabaseShim(client);
const q = (sql, params = []) => client.query(sql, params);

const expectOk = (r) => {
  if (!r.ok) { bad('the read succeeded', `${r.error} — ${r.hint}`); process.exit(1); }
  return r;
};

console.log('\nVendor limits and the credit clock\n');

// ── 0. A workspace that has never generated ─────────────────────────────────────
console.log('0. Nothing has been submitted to any driver\n');
{
  const s = expectOk(await readLimits(db));

  eq('a row per video and audio driver', s.limits.length >= 2, true);

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // Every other assertion in this file is about rows that exist. This is the one about
  // the state the workspace is actually in, and it is the state that makes the naive
  // version of this screen wrong: with nothing submitted, in-flight is 0 and every hit
  // count is 0, so a gauge would read "0 / ceiling, never limited" and go on reading it
  // for ever. `hasSubmitted` is what lets the screen say "—" instead of "0", and the
  // difference is between "this driver has never refused us" and "this driver has never
  // been asked".
  if (s.limits.every((l) => !l.hasSubmitted && l.inFlight === 0)) {
    ok('every driver reports never-submitted, not never-limited', 'the screen renders — not 0');
  } else {
    bad('every driver reports never-submitted, not never-limited', JSON.stringify(s.limits[0]));
  }

  // An unknown ceiling must not be guessed: a guess above the real one produces a
  // permanent failure rate that reads as vendor flakiness rather than as our own setting.
  if (s.limits.every((l) => l.ceiling === null)) {
    ok('an unread ceiling is null, not a guess', 'read from the account at verification');
  } else {
    bad('an unread ceiling is null, not a guess', JSON.stringify(s.limits.map((l) => l.ceiling)));
  }

  eq('  · and its source says the number would be a fallback', s.limits[0].ceilingSource, 'default');

  // No countdown anywhere. A concurrency ceiling is not a window.
  eq('no windowed quota is claimed', QUOTAS.length, 0);

  eq('no purchases yet', s.noPurchases, true);
  if (soonestExpiry(s.credits) === null) {
    ok('  · so there is no expiry clock to show', 'null, not 0 days');
  } else {
    bad('  · so there is no expiry clock to show', JSON.stringify(soonestExpiry(s.credits)));
  }
}

// ── 1. A ceiling that was read, and one that was not ────────────────────────────
console.log('\n1. A fallback is never presented as a reading\n');
{
  await q(
    `update integrations set concurrency_limit = 5, concurrency_source = 'tier'
      where slug = 'higgsfield'`,
  );
  await q(
    `update integrations set concurrency_limit = 2, concurrency_source = 'default'
      where slug = 'elevenlabs'`,
  );

  const s = expectOk(await readLimits(db));
  const hf = s.limits.find((l) => l.slug === 'higgsfield');
  const el = s.limits.find((l) => l.slug === 'elevenlabs');

  eq('a read ceiling carries its source', `${hf.ceiling}/${hf.ceilingSource}`, '5/tier');
  eq('  · and a fallback carries a different one', `${el.ceiling}/${el.ceilingSource}`, '2/default');
}

// ── 2. In flight, and the two refusal kinds counted apart ───────────────────────
console.log('\n2. What is against the ceiling, and what has hit it\n');
{
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  const channelId = randomUUID();
  await q(
    `insert into channels (id, name, platform, niche) values ($1,'lim','youtube','test')`,
    [channelId],
  );
  await q(
    `insert into concepts (id, channel_id, title, angle, rubric_version)
     values ($1,$2,'c','a','v1')`,
    [conceptId, channelId],
  );
  await q(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1,$2,'h','[]'::jsonb,'words','claude-opus-5',$3)`,
    [scriptId, conceptId, randomUUID()],
  );

  const mkGen = async (status, errorCode) => {
    const shotId = randomUUID();
    await q(
      `insert into shots (id, script_id, idx, description, shot_kind, duration_s)
       values ($1,$2,$3,'s','establishing',3)`,
      [shotId, scriptId, Math.floor(Math.random() * 1e6)],
    );
    await q(
      `insert into generations (id, shot_id, kind, driver, model, request_payload,
                                idempotency_key, status, error_code, completed_at)
       values ($1,$2,'image','higgsfield','m','{}'::jsonb,$3,$4,$5,
               case when $5::text is null then null else now() end)`,
      [randomUUID(), shotId, randomUUID(), status, errorCode],
    );
  };

  await mkGen('running', null);
  await mkGen('submitting', null);
  await mkGen('succeeded', null);
  await mkGen('failed', 'concurrency_limited');
  await mkGen('failed', 'concurrency_limited');
  await mkGen('failed', 'rate_limited');

  const s = expectOk(await readLimits(db));
  const hf = s.limits.find((l) => l.slug === 'higgsfield');

  eq('in flight counts only the non-terminal states', hf.inFlight, 2);
  eq('  · out of every submit ever made', hf.submitsTotal, 6);

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // `src/lib/drivers/types.ts` keeps `concurrency_limited` and `rate_limited` distinct on
  // purpose: the first wants a queue and the second wants exponential backoff, and
  // treating a concurrency ceiling as a rate limit produces a retry storm that makes the
  // ceiling worse. A single merged "times you were limited" figure would erase the
  // distinction the driver layer maintains to prevent exactly that — which is why this is
  // the assertion the card's whole shape rests on, not a nicety.
  if (hf.hitsConcurrency === 2 && hf.hitsRate === 1) {
    ok('the two refusal kinds are counted apart', 'a queue and a backoff are different fixes');
  } else {
    bad('the two refusal kinds are counted apart', `${hf.hitsConcurrency} / ${hf.hitsRate}`);
  }

  eq('  · and the driver is now reported as having submitted', hf.hasSubmitted, true);
  if (hf.lastHitAt) ok('  · with the time of the last refusal');
  else bad('  · with the time of the last refusal', 'null');

  const el = s.limits.find((l) => l.slug === 'elevenlabs');
  eq('a driver with no submits is still never-submitted', el.hasSubmitted, false);
}

// ── 3. The credit clock, and the balance that does not exist ────────────────────
console.log('\n3. A position, not a balance\n');
{
  const { rows: [hf] } = await q(`select id from integrations where slug = 'higgsfield'`);

  await q(
    `insert into credit_purchases (integration_id, credits, purchased_at, expiry_days, amount_usd)
     values ($1, 400, current_date - 100, 90, 40)`,
    [hf.id],
  );
  await q(
    `insert into credit_purchases (integration_id, credits, purchased_at, expiry_days, amount_usd)
     values ($1, 1000, current_date - 75, 90, 100)`,
    [hf.id],
  );
  await q(
    `insert into credit_purchases (integration_id, credits, purchased_at, expiry_days, amount_usd)
     values ($1, 500, current_date - 5, 90, 50)`,
    [hf.id],
  );

  const s = expectOk(await readLimits(db));
  const c = s.credits.find((x) => x.slug === 'higgsfield');

  eq('purchases are counted', c.purchases, 3);
  eq('  · expired credits are reported, not dropped', c.creditsExpired, 400);
  eq('  · unexpired separately', c.creditsUnexpired, 1500);
  eq('  · and what dies within the month', c.creditsExpiring30d, 1000);
  eq('the clock runs to the soonest tranche', c.daysUntilExpiry, 15);
  eq('  · and the board asks for exactly that one', soonestExpiry(s.credits).slug, 'higgsfield');
  eq('no longer a workspace with no purchases', s.noPurchases, false);

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // Nothing writes `generations.credits_spent` — six generations exist above and not one
  // carries a figure. So "remaining" is unknown, and the only honest rendering is to
  // refuse to show a balance at all.
  //
  // This is the assertion the whole card is built around, and it is the one that would
  // pass silently in the wrong direction: `creditsUnexpired` is 1500 and putting it under
  // a heading that says "remaining" would look right, read right, and be a stale constant
  // presented as a live balance on the screen an operator checks daily. `credits_spent`
  // gaining a writer flips `consumptionObserved` and this assertion inverts — which is the
  // point, and which is why it asserts the flag rather than the number.
  if (c.consumptionObserved === false && c.creditsSpent === null) {
    ok('consumption is reported as unobserved', 'a purchase total is not a balance');
  } else {
    bad('consumption is reported as unobserved', `${c.consumptionObserved} / ${c.creditsSpent}`);
  }

  // And the inverse, so the flag is not merely always-false. One generation with a figure
  // is enough to make the sum meaningful, and the reader must then surface it.
  await q(`update generations set credits_spent = 12 where driver = 'higgsfield' and status = 'succeeded'`);
  const after = expectOk(await readLimits(db));
  const c2 = after.credits.find((x) => x.slug === 'higgsfield');
  if (c2.consumptionObserved === true && Number(c2.creditsSpent) === 12) {
    ok('  · and becomes observed the moment anything records it', '12 credits');
  } else {
    bad('  · and becomes observed the moment anything records it', `${c2.consumptionObserved} / ${c2.creditsSpent}`);
  }
}

// ── 4. Every withheld number, and the writer it is waiting for ─────────────────
//
// The registry generalises what §3 does for credits. Each entry is a number a screen
// refuses to show, the column whose absence of a writer is the reason, and a probe that
// answers whether that has changed — computed from the data rather than hardcoded, so a
// screen turns itself on the day the writer lands.
console.log('\n4. Numbers withheld pending a writer\n');
{
  const o = await readObservability(db);

  eq('every entry has a probe', Object.keys(o).length, WITHHELD.length);

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // A hardcoded `false` with a comment would look identical to a working registry and stay
  // false for ever. The whole value here is that no entry can be stuck off: the probes read
  // rows, so the only way one stays withheld is that the rows genuinely are not there.
  //
  // `credits_spent` is ALREADY observed at this point, and nothing in this section did
  // that: §3 set `credits_spent = 12` on one generation to test the credit card, and the
  // flag flipped on its own two sections later. That is the property being asserted —
  // the screen turns itself on when a writer appears, without anyone remembering to change
  // it — and it is worth more as an accident of a neighbouring test than as a staged one.
  if (o.credits_spent.observed && o.credits_spent.rows === 1) {
    ok('a writer in §3 flipped credits_spent with nothing here doing it', '1 row');
  } else {
    bad('a writer in §3 flipped credits_spent with nothing here doing it', JSON.stringify(o.credits_spent));
  }

  // The two with no writer anywhere in src/ stay withheld.
  if (!o.generation_settled.observed && !o.publication_outcome.observed) {
    ok('  · while the two with no writer at all stay withheld', 'reconcile rows, publication outcomes');
  } else {
    bad('  · while the two with no writer at all stay withheld', JSON.stringify(o));
  }

  // The generation reconcile: rule 5 says "reconcile on completion" and nothing does it,
  // so a video that generates can never become countable towards cost per video.
  const { rows: [gen] } = await q(
    `select id from generations where driver = 'higgsfield' limit 1`,
  );
  await q(
    `insert into cost_ledger (generation_id, driver, entry_kind, unit, quantity, cost_usd, cost_inr)
     values ($1,'higgsfield','reconcile','credit',1,0.08,7.08)`,
    [gen.id],
  );

  const after = await readObservability(db);
  if (after.generation_settled.observed && after.generation_settled.rows === 1) {
    ok('  · and one reconcile row flips generation_settled on its own', '1 row');
  } else {
    bad('  · and one reconcile row flips generation_settled on its own', JSON.stringify(after.generation_settled));
  }
  if (!after.publication_outcome.observed) {
    ok('  · while publication_outcome stays withheld', 'one writer does not enable the rest');
  } else {
    bad('  · while publication_outcome stays withheld', JSON.stringify(after.publication_outcome));
  }

  // Every entry has to say what appears when the writer lands, so the next person does not
  // re-derive it. A registry that records only the absence is a TODO with better grammar.
  if (WITHHELD.every((w) => w.whenWritten.length > 30 && w.missingWriter.length > 30)) {
    ok('  · and each names both the missing writer and what appears when it lands');
  } else {
    bad('  · and each names both the missing writer and what appears when it lands');
  }
}

await scratch.release();

console.log('');
if (failures > 0) {
  console.error(`${failures} failure(s).\n`);
  process.exit(1);
}
console.log(
  'Ceilings are read or unknown, refusals are counted by kind, and the credit clock is\n' +
    'exact while the balance is absent — because there is not one.\n',
);
process.exit(0);
