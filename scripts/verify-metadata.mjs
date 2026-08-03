#!/usr/bin/env node
/**
 * Stage 9 — publishing metadata, against real Postgres and the real Anthropic client.
 *
 * PROVES:  that metadata is refused for a render with no passing review; that the row lands
 *          as a draft and the DB trigger refuses to move it without a pass; that
 *          `altered_content_disclosed` is set by the code rather than by the model; that the
 *          title-shape check catches a reused construction with different nouns and does not
 *          fire on a genuinely different one; and that a collision is recorded rather than
 *          thrown.
 *
 * DOES NOT: prove the metadata is good. Nothing automated can.
 *
 * ── The shape check is the part worth a harness ──────────────────────────────
 *
 * It is the check *on* the prompt, so it must not be tested by the same reasoning that
 * wrote the prompt. The cases below are titles that differ in every content word and share
 * a construction — which is what a policy reviewer sees scrolling a channel page, and what
 * no per-video check can detect.
 *
 * Usage: node scripts/verify-metadata.mjs <db-url>
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-metadata.mjs <db-url>');
  process.exit(2);
}

let nextMeta = null;
let calls = 0;

const model = createServer(async (req, res) => {
  calls++;
  for await (const _ of req) void _;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: JSON.stringify(nextMeta) }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1500, output_tokens: 300 },
    }),
  );
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const modelUrl = `http://127.0.0.1:${model.address().port}`;

process.env.USD_INR_RATE ??= '88.5';
process.env.APP_URL ??= 'https://harness.invalid';
process.env.WEBHOOK_CALLBACK_BASE_URL ??= 'https://harness.invalid';
process.env.ALLOWED_EMAIL ??= 'harness@invalid.test';
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://harness.invalid';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'harness';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';
process.env.ANTHROPIC_API_KEY ??= 'stub-key';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { runMetadata } = require(`${BUILD}/metadata/run.js`);
const { titleShape, checkUniqueness } = require(`${BUILD}/metadata/schema.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

const scratch = await scratchDatabase(dbUrl, 'metadata');
const client = scratch.client;
const db = supabaseShim(client);

// reviews.reviewer_id is NOT NULL — a review without a reviewer is not a review, which is
// the point of the column. The harness needs a stand-in identity, not a real auth user.
const reviewerId = randomUUID();

const channelId = randomUUID();
await client.query(
  `insert into channels (id, name, platform, niche)
   values ($1, 'verify-metadata', 'youtube', 'urban infrastructure')`,
  [channelId],
);
for (const unit of ['input_token', 'output_token']) {
  await client.query(
    `insert into rate_card (driver, model, endpoint, unit, unit_cost, currency, is_verified, source_note)
     values ('anthropic', 'claude-opus-5', '/v1/messages', $1, 0.000005, 'USD', true, 'harness')`,
    [unit],
  );
}

let n = 0;
async function seedRender({ withPass = true } = {}) {
  n++;
  const conceptId = randomUUID();
  const scriptId = randomUUID();
  const renderId = randomUUID();

  await client.query(
    `insert into concepts (id, channel_id, title, angle, rubric_version, status)
     values ($1, $2, $3, 'The concrete is the story', 'v1', 'in_production')`,
    [conceptId, channelId, `Concept ${n}`],
  );
  await client.query(
    `insert into scripts (id, concept_id, hook, beats, vo_text, drafted_by, structure_hash)
     values ($1, $2, 'a hook', '[]', 'the voiceover text', 'claude-opus-5', $3)`,
    [scriptId, conceptId, `meta-${n}`],
  );
  await client.query(
    `insert into renders (id, script_id, variant_group_id, variant_label, format, width, height,
                          duration_s, status, kind, origin)
     values ($1, $2, $3, 'a', 'shorts_9x16', 1080, 1920, 42, 'ready', 'final', 'pipeline')`,
    [renderId, scriptId, randomUUID()],
  );

  let reviewId = null;
  if (withPass) {
    reviewId = randomUUID();
    await client.query(
      `insert into reviews (id, render_id, reviewer_id, decision, human_edit_count, structure_novel)
       values ($1, $2, $3, 'pass', 3, true)`,
      [reviewId, renderId, reviewerId],
    );
  }
  return { renderId, scriptId, conceptId, reviewId };
}

const DEPS = { db, apiKey: 'stub-key', usdInrRate: 88.5, baseURL: modelUrl };
const meta = (title) => ({
  title,
  description:
    'Road salt dissolves the reinforcement inside concrete bridge decks, and the repair ' +
    'budget is set a year before anyone can see the damage.',
  tags: ['road salt', 'bridges', 'concrete', 'winter maintenance', 'infrastructure'],
});

console.log('\nStage 9 — publishing metadata\n');

// ═══════════════════════════════════════════════════════════════════════════
console.log('1. The title-shape check\n');
{
  const a = titleShape('Why cities are hotter than the countryside');
  const b = titleShape('Why potholes are worse than the budget');
  if (a === b) ok('two titles sharing a construction reduce to one shape', a);
  else bad('two titles sharing a construction reduce to one shape', `${a} vs ${b}`);

  const c = titleShape('Road salt is dissolving your bridges');
  if (c !== a) ok('  · and a different construction does not', c);
  else bad('  · and a different construction does not', c);

  // The listicle case. Different numbers are the same shape, which is the whole point.
  const l1 = titleShape('5 things nobody tells you about concrete');
  const l2 = titleShape('7 things nobody tells you about asphalt');
  if (l1 === l2 && l1.includes('#')) ok('  · numerals collapse, so listicles collide', l1);
  else bad('  · numerals collapse, so listicles collide', `${l1} vs ${l2}`);

  const v = checkUniqueness('Why potholes are worse than the budget', [
    'Why cities are hotter than the countryside',
    'Road salt is dissolving your bridges',
  ]);
  if (!v.unique && v.collidesWith.length === 1) {
    ok('checkUniqueness names what it collided with', v.collidesWith[0]);
  } else {
    bad('checkUniqueness names what it collided with', JSON.stringify(v));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. No metadata without a passing review\n');
{
  const { renderId } = await seedRender({ withPass: false });
  const before = calls;
  nextMeta = meta('Road salt is dissolving your bridges');

  const out = await runMetadata({ renderId }, { ...DEPS, runId: `run-${randomUUID()}` });

  if (!out.ok && out.code === 'no_passing_review') ok('the run refuses', out.code);
  else bad('the run refuses', JSON.stringify(out).slice(0, 160));

  if (calls === before) ok('  · before the model is called', 'no charge for an unpublishable row');
  else bad('  · before the model is called', `${calls - before} call(s)`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n3. A draft, and only a draft\n');
{
  const { renderId, scriptId } = await seedRender();
  nextMeta = meta('Road salt is dissolving your bridges');

  const out = await runMetadata({ renderId }, { ...DEPS, runId: `run-${randomUUID()}` });

  if (out.ok && out.unique) ok('metadata written', `₹${out.costInr?.toFixed(4)}`);
  else bad('metadata written', JSON.stringify(out).slice(0, 200));

  const { rows } = await client.query(
    `select status, altered_content_disclosed, array_length(tags,1) as tagcount, review_id
       from publications where id = $1`,
    [out.publicationId],
  );
  if (rows[0]?.status === 'draft') ok('  · as a draft', 'the only status this stage may write');
  else bad('  · as a draft', rows[0]?.status);

  if (rows[0]?.altered_content_disclosed === true) {
    ok('  · with disclosure set by the code', 'a policy fact, not a model opinion');
  } else {
    bad('  · with disclosure set by the code', String(rows[0]?.altered_content_disclosed));
  }

  // Rule 7, observed rather than trusted. The trigger is the gate; this proves the gate is
  // in front of the row this stage just wrote, not merely in front of some hypothetical one.
  let blocked = null;
  try {
    await client.query(`update publications set status = 'scheduled' where id = $1`, [
      out.publicationId,
    ]);
  } catch (err) {
    blocked = err.message;
  }
  if (blocked === null) {
    ok('  · and the gate lets a passed review through', 'the review decision is "pass"');
  } else {
    bad('  · and the gate lets a passed review through', blocked);
  }

  // And the other direction: a reshoot review must block it.
  const { renderId: r2 } = await seedRender({ withPass: false });
  const reshootId = randomUUID();
  await client.query(
    `insert into reviews (id, render_id, reviewer_id, decision, human_edit_count, structure_novel)
     values ($1,$2,$3,'reshoot',1,true)`,
    [reshootId, r2, reviewerId],
  );
  const pubId = randomUUID();
  await client.query(
    `insert into publications (id, render_id, channel_id, review_id, title,
                               altered_content_disclosed, status)
     values ($1,$2,$3,$4,'A draft nobody may publish', true, 'draft')`,
    [pubId, r2, channelId, reshootId],
  );
  let refused = null;
  try {
    await client.query(`update publications set status = 'scheduled' where id = $1`, [pubId]);
  } catch (err) {
    refused = err.message;
  }
  if (refused && /blocked/.test(refused)) {
    ok('  · and refuses a reshoot', 'enforce_review_pass, with no application bypass');
  } else {
    bad('  · and refuses a reshoot', String(refused));
  }

  const { rows: cost } = await client.query(
    `select count(*)::int as n from cost_ledger where script_id = $1 and stage = '09-metadata'`,
    [scriptId],
  );
  if (cost[0].n === 2) ok('the call is charged to the script', '2 rows, input and output');
  else bad('the call is charged to the script', `${cost[0].n} rows`);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n4. A reused shape is recorded, not thrown\n');
{
  const { renderId } = await seedRender();
  // Every content word differs from the title already published above; the construction
  // does not. This is the case no per-video check can see.
  nextMeta = meta('Winter grit is dissolving your culverts');

  const out = await runMetadata({ renderId }, { ...DEPS, runId: `run-${randomUUID()}` });

  if (out.ok) ok('the run succeeds', 'a collision is a judgement, not a failure');
  else bad('the run succeeds', JSON.stringify(out).slice(0, 160));

  if (out.ok && out.unique === false && out.collidesWith.length >= 1) {
    ok('  · and reports the collision', `"${out.collidesWith[0]}"`);
  } else {
    bad('  · and reports the collision', JSON.stringify(out).slice(0, 200));
  }

  const { rows } = await client.query(
    `select count(*)::int as n from publications where channel_id = $1`,
    [channelId],
  );
  if (rows[0].n >= 3) ok('  · and the draft is still written', `${rows[0].n} publications`);
  else bad('  · and the draft is still written', `${rows[0].n}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//
// The case the lint found before a human did.
console.log('\n5. A second run is refused, because it could not be recorded\n');
{
  const { renderId } = await seedRender();
  nextMeta = meta('Culvert grates are a maintenance trap');

  const first = await runMetadata({ renderId }, { ...DEPS, runId: `run-${randomUUID()}` });
  if (first.ok) ok('the first run writes a draft');
  else bad('the first run writes a draft', JSON.stringify(first).slice(0, 160));

  const before = calls;
  const second = await runMetadata({ renderId }, { ...DEPS, runId: `run-${randomUUID()}` });

  if (!second.ok && second.code === 'already_has_metadata') {
    ok('  · and the second is refused', second.code);
  } else {
    bad('  · and the second is refused', JSON.stringify(second).slice(0, 160));
  }

  // The point. The ledger keys metadata on (script_id, stage, entry_kind, unit), so a
  // second charge cannot land — which makes a second *call* a payment with no record.
  if (calls === before) ok('  · before the model is called', 'a charge that cannot be recorded is a call that must not happen');
  else bad('  · before the model is called', `${calls - before} call(s)`);
}

model.close();
await scratch.release();

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}

console.log(
  '\nStage 9 refuses without a pass, writes a draft, and measures its own prompt.\n' +
    'What no harness can tell you: whether the titles are any good.\n',
);
