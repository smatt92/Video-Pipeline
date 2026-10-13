#!/usr/bin/env node
/**
 * routedBatch() (src/lib/llm/batch.ts) against a scratch database and a stubbed Message
 * Batches API.
 *
 * Inputs: a channel, the Bureau's bible, the stub's answers. Every assertion reads what the
 * code under test SENT to the stub or WROTE to the database — llm_batch_requests and
 * cost_ledger — and the expected costs are recomputed from rate_card rows read here, never
 * from the module that wrote them.
 *
 * What it proves: a batched call is refused before anything is sent when the batch endpoint is
 * unpriced; at submit it creates one batch and writes ESTIMATE rows at the batch rate (rule 5);
 * asking again never sends a second batch (rule 6); an ended success writes RECONCILE rows from
 * the result's own usage and returns the schema-checked output; errored requests write no
 * reconcile; truncation and schema failures are billed and refused; the sweep reconciles a
 * request nobody asks for again; and the nightly brief draft rides the same path.
 *
 * What it does not: send a real batch. Rule 8 — see 0008 §37.
 *
 * Usage: node scripts/verify-batch.mjs <db-url>   (or set DATABASE_URL)
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const so = require.resolve('server-only');
require.cache[so] = { id: so, filename: so, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-batch.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://harness.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'harness';

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { routedBatch, sweepBatches, BATCH_ENDPOINT } = require(`${BUILD}/llm/batch.js`);
const { RouterError } = require(`${BUILD}/llm/router.js`);
const { draftBriefForSlotBatched, briefBatchKey, briefBatchCustomId } = require(`${BUILD}/bureau/brief-generator.js`);
const { BUREAU_CHANNEL_ID: BUREAU } = require(`${BUILD}/fixtures/seed-channel.js`);
const { importFolderBible } = require(`${BUILD}/channels/bible-admin.js`);
const { z } = require('zod');
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};

const scratch = await scratchDatabase(dbUrl, 'batch');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, params = []) => (await client.query(sql, params)).rows;
const FX = 88;

// ── The stub Message Batches API ─────────────────────────────────────────────
const batches = new Map();
const calls = { create: 0, retrieve: 0, results: 0 };
const sent = [];
const stub = {
  messages: {
    batches: {
      create: async (body) => {
        calls.create++;
        sent.push(body);
        const id = `msgbatch_${randomUUID().slice(0, 12)}`;
        batches.set(id, { requests: body.requests, status: 'in_progress', results: new Map() });
        return { id, processing_status: 'in_progress' };
      },
      retrieve: async (id) => {
        calls.retrieve++;
        return { id, processing_status: batches.get(id).status };
      },
      results: async (id) => {
        calls.results++;
        const b = batches.get(id);
        return (async function* () {
          for (const [custom_id, result] of b.results) yield { custom_id, result };
        })();
      },
    },
  },
};
/** End the batch that carries `customId`, with this result for it. */
function end(customId, result) {
  for (const b of batches.values()) {
    if (b.requests.some((r) => r.custom_id === customId)) {
      b.results.set(customId, result);
      b.status = 'ended';
      return;
    }
  }
  throw new Error(`no batch carries ${customId}`);
}
const success = (output, usage, stop = 'end_turn') => ({
  type: 'succeeded',
  message: {
    id: `msg_${randomUUID().slice(0, 8)}`, type: 'message', role: 'assistant', model: 'stub',
    content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }],
    stop_reason: stop, stop_sequence: null,
    usage: { input_tokens: usage[0], output_tokens: usage[1], cache_read_input_tokens: null, cache_creation_input_tokens: null },
  },
});

const ledgerFor = (key) => q(`select entry_kind, unit, quantity::int as quantity, cost_usd::float8 as cost_usd, idempotency_key, stage, channel_id from cost_ledger where idempotency_key like $1 order by entry_kind, unit`, [`batch:${key}:%`]);
const rate = async (model, endpoint, unit) => Number((await q(`select unit_cost from rate_card where driver = 'anthropic' and model = $1 and endpoint = $2 and unit = $3 and is_verified order by effective_from desc limit 1`, [model, endpoint, unit]))[0]?.unit_cost);

try {
  // ═══ 0. The world ═══
  const CH = randomUUID();
  await q(`insert into channels (id, name, platform, niche) values ($1, 'verify-batch', 'youtube', 'captions')`, [CH]);
  const Lines = z.object({ lines: z.array(z.string()) });
  const deps = (over = {}) => ({ db, apiKey: 'stub', usdInrRate: FX, client: stub, subject: { kind: 'channel', channelId: CH, idempotencyKey: 'caller-key', stage: '24-dub-captions' }, ...over });
  const translation = (customId) => ({ task: 'translation', customId, system: 'S'.repeat(400), user: 'U'.repeat(800), schema: Lines, maxTokens: 2000 });

  const hIn = await rate('claude-haiku-5-5', BATCH_ENDPOINT, 'input_token');
  const hOut = await rate('claude-haiku-5-5', BATCH_ENDPOINT, 'output_token');
  const hInSync = await rate('claude-haiku-5-5', '/v1/messages', 'input_token');
  const hOutSync = await rate('claude-haiku-5-5', '/v1/messages', 'output_token');
  console.log('\n0. The rates 0054 carries\n');
  check(hIn === 0.00000005 && hOut === 0.00000025, 'Haiku 5.5 on the batch endpoint is the published $0.05 / $0.25 per MTok', `${hIn} / ${hOut}`);
  check(hIn * 2 === hInSync && hOut * 2 === hOutSync, 'and exactly half of the synchronous endpoint', `${hInSync} / ${hOutSync}`);

  // ═══ 1. Submit ═══
  console.log('\n1. Submit: one batch, estimate rows at the batch rate\n');
  const first = await routedBatch(translation('translate-T1'), deps());
  check(first.state === 'pending' && calls.create === 1, 'the first ask submits one batch and says pending', `${first.state}, ${calls.create} create`);
  const p = sent[0]?.requests?.[0];
  check(p?.custom_id === 'translate-T1' && p.params.model === 'claude-haiku-5-5' && p.params.max_tokens === 2000, 'the request carries the key, the fast-tier model and the budget', JSON.stringify([p?.custom_id, p?.params?.model]));
  check(p?.params?.thinking?.type === 'disabled' && p.params.output_config?.format?.type === 'json_schema' && p.params.output_config.format.schema?.type === 'object', 'thinking disabled, and the output constrained by the call’s JSON schema', JSON.stringify(p?.params?.thinking));
  const [row1] = await q(`select status, batch_id, model, task from llm_batch_requests where custom_id = 'translate-T1'`);
  check(row1?.status === 'submitted' && row1.batch_id && row1.model === 'claude-haiku-5-5', 'its row says submitted, with the batch id', JSON.stringify(row1));
  const est = await ledgerFor('translate-T1');
  const inEst = est.find((r) => r.unit === 'input_token');
  const outEst = est.find((r) => r.unit === 'output_token');
  // LOAD-BEARING (rule 5): written at submit, before any result exists, on quantities computed
  // here from the call's own text and budget, at a rate read here from rate_card.
  check(est.length === 2 && est.every((r) => r.entry_kind === 'estimate' && r.channel_id === CH && r.stage === '24-dub-captions') && inEst?.quantity === 300 && outEst?.quantity === 2000,
    'two ESTIMATE rows at submit: (400 + 800) chars / 4 = 300 input, the 2,000 budget as output', JSON.stringify(est.map((r) => [r.entry_kind, r.unit, r.quantity])));
  check(Math.abs(inEst.cost_usd - 300 * hIn) < 1e-12 && Math.abs(outEst.cost_usd - 2000 * hOut) < 1e-12, 'priced at the batch rate', `$${(inEst.cost_usd + outEst.cost_usd).toFixed(7)}`);
  check(est.every((r) => r.idempotency_key.startsWith('batch:translate-T1:estimate:')), 'keyed on the custom_id, not the caller’s key', est[0]?.idempotency_key);

  // ═══ 2. Idempotent ═══
  console.log('\n2. Asking again never pays twice\n');
  const again = await routedBatch(translation('translate-T1'), deps());
  check(again.state === 'pending' && calls.create === 1 && (await ledgerFor('translate-T1')).length === 2, 'still pending, no second batch, no second estimate', `${calls.create} create`);

  // ═══ 3. Success ═══
  console.log('\n3. An ended success: reconcile from its own usage, then the output\n');
  end('translate-T1', success({ lines: ['uno', 'dos'] }, [280, 90]));
  const done = await routedBatch(translation('translate-T1'), deps());
  check(done.state === 'done' && JSON.stringify(done.data) === '{"lines":["uno","dos"]}' && done.model === 'claude-haiku-5-5', 'done, with the schema-checked output', JSON.stringify(done.data));
  const after = await ledgerFor('translate-T1');
  const rec = after.filter((r) => r.entry_kind === 'reconcile');
  check(rec.length === 2 && rec.find((r) => r.unit === 'input_token')?.quantity === 280 && rec.find((r) => r.unit === 'output_token')?.quantity === 90, 'two RECONCILE rows at the result’s exact usage', JSON.stringify(rec.map((r) => [r.unit, r.quantity])));
  check(Math.abs(rec.reduce((n, r) => n + r.cost_usd, 0) - (280 * hIn + 90 * hOut)) < 1e-12, 'priced at the batch rate', `$${rec.reduce((n, r) => n + r.cost_usd, 0).toFixed(7)}`);
  const retrievesBefore = calls.retrieve;
  const stored = await routedBatch(translation('translate-T1'), deps());
  check(stored.state === 'done' && calls.retrieve === retrievesBefore && (await ledgerFor('translate-T1')).length === 4, 'read again: from the row, with no API call and no new rows');

  // ═══ 4. Unpriced ═══
  console.log('\n4. Refused before anything is sent when the batch endpoint is unpriced\n');
  const createsBefore = calls.create;
  const unpriced = await routedBatch({ ...translation('judge-T1'), task: 'policy_judge' }, deps()).then(() => null, (e) => e);
  check(unpriced instanceof RouterError && unpriced.code === 'unpriced' && calls.create === createsBefore, 'the judge tier has no batch rate: refused, nothing sent', unpriced?.message?.slice(0, 120));
  check((await q(`select 1 from llm_batch_requests where custom_id = 'judge-T1'`)).length === 0, 'and no row recorded');

  // ═══ 5. Errored ═══
  console.log('\n5. An errored request is not billed and gets no reconcile\n');
  await routedBatch(translation('translate-T2'), deps());
  end('translate-T2', { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: 'stub' } } });
  const errored = await routedBatch(translation('translate-T2'), deps());
  const e2 = await ledgerFor('translate-T2');
  check(errored.state === 'failed' && /errored/.test(errored.reason) && e2.length === 2 && e2.every((r) => r.entry_kind === 'estimate'), 'failed; its estimate stays, no reconcile is invented', JSON.stringify(e2.map((r) => r.entry_kind)));

  // ═══ 6. Truncated, and 7. off-schema ═══
  console.log('\n6–7. Billed failures are reconciled, then refused\n');
  await routedBatch(translation('translate-T3'), deps());
  end('translate-T3', success('{"lines": ["cut off', [500, 2000], 'max_tokens'));
  const truncated = await routedBatch(translation('translate-T3'), deps());
  const r3 = (await ledgerFor('translate-T3')).filter((r) => r.entry_kind === 'reconcile');
  check(truncated.state === 'failed' && /truncated|2000 tokens/.test(truncated.reason) && r3.find((r) => r.unit === 'output_token')?.quantity === 2000, 'a truncation is refused AND reconciled at its 2,000 output tokens', truncated.state === 'failed' ? truncated.reason : 'done');
  await routedBatch(translation('translate-T4'), deps());
  end('translate-T4', success({ nope: 1 }, [300, 20]));
  const offSchema = await routedBatch(translation('translate-T4'), deps());
  const r4 = (await ledgerFor('translate-T4')).filter((r) => r.entry_kind === 'reconcile');
  check(offSchema.state === 'failed' && /lines/.test(offSchema.reason) && r4.length === 2, 'JSON that misses the schema is refused by name, and still reconciled', offSchema.state === 'failed' ? offSchema.reason : 'done');

  // ═══ 8. The sweep ═══
  console.log('\n8. The sweep reconciles a request nobody asks for again\n');
  await routedBatch(translation('translate-T5'), deps());
  end('translate-T5', success({ lines: ['x'] }, [310, 12]));
  const swept = await sweepBatches('translate-', { db, apiKey: 'stub', client: stub });
  const r5 = (await ledgerFor('translate-T5')).filter((r) => r.entry_kind === 'reconcile');
  check(swept.length === 1 && swept[0].customId === 'translate-T5' && swept[0].status === 'succeeded' && swept[0].subject?.channelId === CH, 'it collects exactly the ended request, and hands back its subject', JSON.stringify(swept.map((s) => [s.customId, s.status])));
  check(r5.length === 2 && r5.find((r) => r.unit === 'input_token')?.quantity === 310, 'with its reconcile written, though no caller asked', JSON.stringify(r5.map((r) => [r.unit, r.quantity])));
  check((await sweepBatches('translate-', { db, apiKey: 'stub', client: stub })).length === 0, 'and a second sweep finds nothing left open');

  const bad = await routedBatch(translation('has spaces'), deps()).then(() => null, (e) => e);
  check(bad instanceof RouterError && calls.create === createsBefore + 4, 'a custom_id the API would reject is refused before anything is sent', bad?.message?.slice(0, 80));

  // ═══ 9. The nightly brief, batched ═══
  console.log('\n9. The safety net’s brief draft rides the same path\n');
  await importFolderBible(db, { channelId: BUREAU, slug: 'bureau-of-reality', by: 'verify:batch' });
  const [slot] = await q(`select id, series from slots where id = 'S001' and channel_id = $1`, [BUREAU]);
  check(slot?.id === 'S001', 'a seeded Bureau slot to draft for', JSON.stringify(slot));
  const briefDeps = { db, apiKey: 'stub', usdInrRate: FX, channelId: BUREAU, client: stub };
  const key = briefBatchCustomId('S001', '2026-10-13');
  check(key === 'brief-S001-20261013' && JSON.stringify(briefBatchKey(key)) === '{"slotId":"S001","dayKey":"20261013"}', 'the key names the slot and the day, and parses back', key);
  const pend = await draftBriefForSlotBatched(db, 'S001', '2026-10-13', briefDeps);
  const briefReq = sent.at(-1)?.requests?.[0];
  check(pend.state === 'pending' && briefReq?.custom_id === key && briefReq.params.model === 'claude-sonnet-5-5' && briefReq.params.max_tokens === 4000 && !briefReq.params.thinking, 'submitted on the writer tier, under the slot-and-day key', JSON.stringify([pend.state, briefReq?.params?.model]));
  const bEst = await ledgerFor(key);
  check(bEst.length === 2 && bEst.every((r) => r.entry_kind === 'estimate' && r.stage === '20-brief' && r.channel_id === BUREAU), 'estimated at submit against the channel, stage 20-brief', JSON.stringify(bEst.map((r) => [r.unit, r.quantity])));
  const draft = {
    lead_character: 'pip', supporting_characters: ['marlo'], desk: 'gravity',
    premise: 'Pip misplaces the Moon and the tides file a formal complaint by Friday.', premise_type: 'what_if_removed',
    structure_variant: 'ladder_hourly', ending_type: 'callback_gag', music_bed: 'bed_typewriter_shuffle', hook_archetype: 'story_open', catchphrase_used: null,
    punchlines: ['The Moon is in Lost Property.', 'Tides are now on strike.', 'Marlo stamps it: "Gravitationally Unavailable".'],
    beat_sheet: [{ beat_id: 'cold_open', summary: 'Empty sky, Pip with a clipboard.' }, { beat_id: 'stakes', summary: 'Tides stop.' }],
    script_text: 'Pip: I may have misplaced the Moon.\nMarlo: The Moon holds the tides. No Moon, smaller tides by Friday.\nPip: How much smaller?\nMarlo: About a third of what you are used to.',
    shot_list: [
      { beat_id: 'cold_open', route: 'overlay', description: 'Blueprint sky, empty orbit ring', duration_s: 6, characters: [], realistic: false },
      { beat_id: 'stakes', route: 'character_beat', description: 'Pip turns, clipboard falls', duration_s: 4, characters: ['pip'], realistic: false },
      { beat_id: 'mechanism_1', route: 'overlay', description: 'Tidal bulge diagram', duration_s: 10, characters: [], realistic: false },
    ],
    fact: { claim: "The Moon's gravity is the main cause of Earth's ocean tides.", source_url: 'https://oceanservice.noaa.gov/facts/moon-tides.html', source_title: 'NOAA' },
    titles: [{ text: 'Pip lost the Moon', hook_archetype: 'story_open' }, { text: 'What if the Moon vanished?', hook_archetype: 'question' }, { text: 'Tides drop by two thirds', hook_archetype: 'number_claim' }],
    pinned_comment: 'Which desk should Pip break next?',
  };
  check((await draftBriefForSlotBatched(db, 'S001', '2026-10-13', briefDeps)).state === 'pending', 'still pending before the batch ends');
  end(key, success(draft, [1500, 2800]));
  const landed = await draftBriefForSlotBatched(db, 'S001', '2026-10-13', briefDeps);
  check(landed.state === 'done' && landed.result.ok && landed.result.brief.slot_id === 'S001' && landed.result.brief.tags.includes('drafted:server'), 'collected: a brief for S001 that passed the channel’s brief schema', landed.state === 'done' ? (landed.result.ok ? landed.result.brief.premise.slice(0, 50) : landed.result.error) : landed.state);
  const bRec = (await ledgerFor(key)).filter((r) => r.entry_kind === 'reconcile');
  check(bRec.length === 2 && bRec.find((r) => r.unit === 'output_token')?.quantity === 2800, 'and reconciled at its own usage', JSON.stringify(bRec.map((r) => [r.unit, r.quantity])));
  const sIn = await rate('claude-sonnet-5-5', BATCH_ENDPOINT, 'input_token');
  const sOut = await rate('claude-sonnet-5-5', BATCH_ENDPOINT, 'output_token');
  check(Math.abs(bRec.reduce((n, r) => n + r.cost_usd, 0) - (1500 * sIn + 2800 * sOut)) < 1e-12 && sIn === 0.000001 && sOut === 0.000005, 'at Sonnet 5.5’s published batch rate', `$${bRec.reduce((n, r) => n + r.cost_usd, 0).toFixed(6)}`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await scratch.release();
}

if (failures > 0) {
  console.error(`\n${failures} failure(s).\n`);
  process.exit(1);
}
console.log('\nverify:batch — all checks passed.\n');
