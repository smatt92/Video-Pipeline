#!/usr/bin/env node
/**
 * verify:bureau — the Bureau control plane on /api/mcp, over real HTTP, against a scratch
 * Postgres with every migration applied.
 *
 * What this proves, and how each side of every assertion arrives independently:
 *
 *   SCOPE       An agent token never reaches a decision. Checked three ways — tools/list hides
 *               approver tools from it, tools/call refuses them with scope_denied and the
 *               database is unchanged afterwards (counted, not assumed), and the decision
 *               functions themselves raise when handed an agent token directly. The third is
 *               LOAD-BEARING: it is the only one that holds if a future caller skips the TS.
 *   AUTHORSHIP  Every approve/reject/caps/kill-switch/schedule writes authorship_log with the
 *               exact text, in the same transaction — and the log refuses UPDATE/DELETE.
 *   DECISIONS   brief_approve creates the episode and asks the effects layer to start it;
 *               cut_approve records a pass review by the token's person and wakes the gate.
 *   CONSUMERS   The kill switch is asserted at the consumer: claim_gen_jobs hands out nothing
 *               and the publish trigger refuses. The daily publish cap is asserted the same way.
 *
 * Inputs are seeded (a profile, a render to review, a draft publication); every assertion
 * reads a row the code under test wrote, or a call it made into the recording effects.
 *
 * Usage: node scripts/verify-bureau.mjs <db-url>
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-bureau.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { serveMcp } = require(`${BUILD}/studio/serve.js`);
const { mintBureauToken, revokeBureauToken } = require(`${BUILD}/bureau/tokens.js`);
const { BUREAU_TOOLS } = require(`${BUILD}/bureau/mcp/surface.js`);
const { BUREAU_CHANNEL_ID } = require(`${BUILD}/bureau/bible.js`);

const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');
const { stubEmbedder } = await import('./lib/stub-embedder.mjs');

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};
const check = (cond, label, detail = '') => (cond ? ok(label, detail) : bad(label, detail));

const scratch = await scratchDatabase(dbUrl, 'bureau');
const client = scratch.client;
const db = supabaseShim(client);

// ── Recording effects: what the control plane asked the outside world to do ──
const effects = {
  started: [],
  woken: [],
  notified: [],
  // No embedder until §5: the briefs are drafted while embeddings are unavailable.
  embed: null,
  async embedderFor() {
    return this.embed ?? undefined;
  },
  async startEpisode(id) {
    this.started.push(id);
    return `run_verify_${this.started.length}`;
  },
  async completeWaitToken(token, output) {
    this.woken.push({ token, output });
  },
  async notify(channelId, kind, text) {
    this.notified.push({ channelId, kind, text });
  },
};

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    try {
      const r = await serveMcp({ authorization: req.headers.authorization ?? null, body }, { db, secret: undefined, bureau: effects });
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.body === null ? '' : JSON.stringify(r.body));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${server.address().port}/api/mcp`;

async function rpc(method, params, token) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function call(name, args, token) {
  const { body } = await rpc('tools/call', { name, arguments: args }, token);
  return { result: body?.result?.structuredContent, isError: body?.result?.isError, error: body?.error };
}
const count = async (sql, params = []) => Number((await client.query(sql, params)).rows[0].n);

console.log('\nBureau control plane verification\n');

try {
  // ═══════════════════════════════════════════════════════════════════════════
  // 0. People and tokens
  // ═══════════════════════════════════════════════════════════════════════════
  const { rows: prof } = await client.query(
    `insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'sahil@invalid.test', 88) returning id`,
  );
  const profileId = prof[0].id;

  const approver = await mintBureauToken(db, { name: 'Sahil (claude.ai)', scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId });
  const agent = await mintBureauToken(db, { name: 'Routine C', scope: 'agent', channelId: BUREAU_CHANNEL_ID, profileId: null });
  const revoked = await mintBureauToken(db, { name: 'old', scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId });
  await revokeBureauToken(db, revoked.id);

  console.log('0. Tokens\n');
  check(/^kb_a_/.test(approver.plaintext) && /^kb_g_/.test(agent.plaintext), 'tokens carry their scope in the prefix');
  const stored = (await client.query('select token_hash from mcp_tokens where id = $1', [approver.id])).rows[0].token_hash;
  check(stored.length === 64 && !stored.includes(approver.plaintext.slice(5)), 'only the SHA-256 is stored');
  let refusedAgentApprover = false;
  try {
    await mintBureauToken(db, { name: 'x', scope: 'approver', channelId: BUREAU_CHANNEL_ID, profileId: null });
  } catch {
    refusedAgentApprover = true;
  }
  check(refusedAgentApprover, 'an approver token without a person is refused');

  console.log('\n1. Authentication\n');
  check((await rpc('tools/list', {}, null)).status === 401, 'no token → 401');
  check((await rpc('tools/list', {}, 'kb_a_not-a-real-token')).status === 401, 'unknown kb_ token → 401');
  check((await rpc('tools/list', {}, revoked.plaintext)).status === 401, 'revoked token → 401');
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, approver.plaintext);
  check(init.status === 200 && init.body.result.serverInfo.name === 'kiln-bureau', 'approver initializes the Bureau surface', init.body?.result?.serverInfo?.name);
  check(init.body.result.capabilities.resources !== undefined, 'the Bureau surface advertises resources');
  const lastUsed = (await client.query('select last_used_at from mcp_tokens where id = $1', [approver.id])).rows[0].last_used_at;
  check(lastUsed !== null, 'a successful request stamps last_used_at');

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. Scope — listing
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n2. Scope: what each token sees\n');
  const approverOnly = BUREAU_TOOLS.filter((t) => t.scope === 'approver').map((t) => t.name).sort();
  const expectedApproverOnly = ['brief_approve', 'brief_reject', 'caps_set', 'cut_approve', 'cut_reject', 'kill_switch', 'mark_scheduled', 'publish_bundles'];
  check(JSON.stringify(approverOnly) === JSON.stringify(expectedApproverOnly), 'the approver-only set is exactly the decisions', approverOnly.join(','));
  const agentList = (await rpc('tools/list', {}, agent.plaintext)).body.result.tools.map((t) => t.name);
  const approverList = (await rpc('tools/list', {}, approver.plaintext)).body.result.tools.map((t) => t.name);
  check(agentList.every((n) => !approverOnly.includes(n)), 'tools/list hides every approver tool from an agent', `${agentList.length} tools`);
  check(approverList.length === BUREAU_TOOLS.length, 'the approver sees every tool', `${approverList.length}`);
  check(approverList.length === 21, 'there are 21 Bureau tools', `${approverList.length}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Drafting as the agent
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n3. briefs_create_batch (agent)\n');
  const goodBrief = (slot, extra = {}) => ({
    slot_id: slot,
    series: 'incident',
    lead_character: 'pip',
    supporting_characters: ['marlo'],
    desk: 'gravity',
    premise: 'Pip misplaces the Moon and the tides file a formal complaint by Friday.',
    premise_type: 'what_if_removed',
    structure_variant: 'ladder_hourly',
    ending_type: 'callback_gag',
    music_bed: 'bed_typewriter_shuffle',
    hook_archetype: 'story_open',
    punchlines: ['The Moon is in Lost Property.', 'Tides are now on strike.', 'Marlo stamps it: "Gravitationally Unavailable".'],
    beat_sheet: [{ beat_id: 'cold_open', summary: 'Empty sky, Pip with a clipboard.' }, { beat_id: 'stakes', summary: 'Tides stop.' }],
    script_text: 'Pip: I may have misplaced the Moon.\nMarlo: The Moon holds the tides. No Moon, smaller tides by Friday.\nPip: How much smaller?\nMarlo: About a third of what you are used to.',
    shot_list: [
      { beat_id: 'cold_open', route: 'overlay', description: 'Blueprint sky, empty orbit ring', duration_s: 6 },
      { beat_id: 'stakes', route: 'character_beat', description: 'Pip turns, clipboard falls', duration_s: 4, characters: ['pip'] },
      { beat_id: 'mechanism_1', route: 'overlay', description: 'Tidal bulge diagram', duration_s: 10 },
    ],
    fact: { claim: "The Moon's gravity is the main cause of Earth's ocean tides.", source_url: 'https://oceanservice.noaa.gov/facts/moon-tides.html' },
    titles: [
      { text: 'Pip lost the Moon', hook_archetype: 'story_open' },
      { text: 'What if the Moon vanished?', hook_archetype: 'question' },
      { text: 'Tides drop by two thirds', hook_archetype: 'number_claim' },
    ],
    pinned_comment: 'Which desk should Pip break next?',
    ...extra,
  });
  const batch = await call('briefs_create_batch', { briefs: [goodBrief('S001'), goodBrief('S002', { structure_variant: 'not_a_variant' }), goodBrief('S004', { premise: 'Marlo explains why the Moon is drifting away from Earth slowly.' })] }, agent.plaintext);
  const results = batch.result?.results ?? [];
  check(batch.result?.created === 2 && batch.result?.failed === 1, 'two briefs land, the malformed one fails alone', JSON.stringify(results.map((r) => r.ok)));
  check(/structure_variant/.test(results[1]?.error ?? ''), 'the failure names the field', results[1]?.error);
  const briefA = results[0].brief_id;
  const briefB = results[2].brief_id;
  const rowA = (await client.query('select created_by, created_by_token, variation, policy, flagged, estimate_inr from briefs where id = $1', [briefA])).rows[0];
  check(rowA.created_by === 'agent' && rowA.created_by_token === agent.id, 'the brief records which token drafted it');
  check(rowA.variation.status === 'refused' && /similarity not computed — embeddings are not configured/.test(rowA.variation.refused_reason ?? ''),
    'variation is "refused", with the reason named, when similarity could not be computed — never a pass, never 0', `${rowA.variation.status}: ${rowA.variation.refused_reason}`);
  check(rowA.flagged === true, 'and the brief is flagged for it');
  check(rowA.policy.status === 'pass', 'the server re-ran policy_lint itself', rowA.policy.status);
  check(rowA.estimate_inr === null, 'the estimate is null (unpriced), never 0, while a route has no recipe', String(rowA.estimate_inr));
  check(effects.notified.some((n) => n.kind === 'briefs_pending'), 'a briefs_pending alert was requested');
  const dup = await call('briefs_create_batch', { briefs: [goodBrief('S001')] }, agent.plaintext);
  check(/already has a pending/.test(dup.result?.results?.[0]?.error ?? ''), 'a second live brief for one slot is refused', dup.result?.results?.[0]?.error);

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Scope — the agent cannot decide
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n4. Scope: an agent token cannot decide\n');
  const logBefore = await count('select count(*) n from authorship_log');
  const attempts = {
    brief_approve: { id: briefA, punchline: 'A' },
    brief_reject: { id: briefA, reason: 'no' },
    cut_approve: { id: randomUUID() },
    cut_reject: { id: randomUUID(), note: 'no thanks' },
    publish_bundles: {},
    mark_scheduled: { id: randomUUID(), at: '2026-10-19T12:30:00Z' },
    caps_set: { changes: { per_short_cap_inr: 1 } },
    kill_switch: { on: true, reason: 'x' },
  };
  for (const [name, args] of Object.entries(attempts)) {
    const r = await call(name, args, agent.plaintext);
    check(r.result?.refused === true && r.result?.blockers?.[0]?.code === 'scope_denied', `agent → ${name} is refused with scope_denied`);
  }
  check((await count('select count(*) n from authorship_log')) === logBefore, 'and nothing was written by any of them');
  check((await client.query('select status from briefs where id = $1', [briefA])).rows[0].status === 'pending', 'the brief is still pending');
  check((await client.query('select per_short_cap_inr, kill_switch from channel_policy where channel_id = $1', [BUREAU_CHANNEL_ID])).rows[0].kill_switch === false, 'the kill switch is untouched');

  // LOAD-BEARING: the database refuses an agent token even when the TypeScript is bypassed.
  for (const [fn, args] of [
    ['bureau_brief_approve', `$1, '${briefA}', 'x', 'A', '{}'::jsonb`],
    ['bureau_caps_set', `$1, '{"per_short_cap_inr": 1}'::jsonb`],
    ['bureau_kill_switch', `$1, true, 'x'`],
  ]) {
    let raised = null;
    try {
      await client.query(`select ${fn}(${args})`, [agent.id]);
    } catch (err) {
      raised = err.message;
    }
    check(/scope_denied/.test(raised ?? ''), `the database itself refuses ${fn} for an agent token`, raised ?? 'it ran');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Approving and rejecting briefs
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n5. brief_approve / brief_reject (approver)\n');
  const pending = await call('briefs_pending', {}, approver.plaintext);
  check(pending.result?.count === 2 && pending.result.briefs[0].n === 1, 'briefs_pending lists both, numbered', `${pending.result?.count}`);

  // LOAD-BEARING: the consumer refuses a brief whose repetition check could not run — in the
  // TypeScript and, below, in the database itself.
  const refusedApprove = await call('brief_approve', { id: briefA, punchline: 'B' }, approver.plaintext);
  check(refusedApprove.isError === true && /variation_check refused this brief: similarity not computed/.test(refusedApprove.result?.error ?? ''),
    'brief_approve refuses while variation_check could not compute similarity, naming why', refusedApprove.result?.error);
  check(effects.started.length === 0 && (await client.query('select status from briefs where id = $1', [briefA])).rows[0].status === 'pending', 'nothing started, the brief is still pending');
  let dbRefused = null;
  try {
    await client.query(`select bureau_brief_approve($1, $2, 'x', 'A', '{}'::jsonb)`, [approver.id, briefA]);
  } catch (err) {
    dbRefused = err.message;
  }
  check(/variation_check refused/.test(dbRefused ?? ''), 'the database refuses it too, for a caller that skips the TypeScript', dbRefused ?? 'it ran');

  // Embeddings come back: variation_check on the brief computes, stores, and lifts the refusal.
  effects.embed = stubEmbedder;
  const recheck = await call('variation_check', { brief_id: briefA }, agent.plaintext);
  const rowA2 = (await client.query('select variation, embedding_model, script_embedding is not null has_vec, flag_reasons from briefs where id = $1', [briefA])).rows[0];
  // Not "pass": briefB (S004) now exists and shares axes with A, which the re-check correctly
  // sees. What matters is that the check RAN — a computed fail is the approver's call.
  check(recheck.result?.similarity?.checked === true && rowA2.variation.similarity.checked === true && rowA2.variation.status !== 'refused' && rowA2.variation.refused_reason === null && rowA2.has_vec && rowA2.embedding_model === 'harness-stub',
    're-running variation_check computes the embedding and stores a computed result on the brief', `${recheck.result?.status} / ${rowA2.variation.status}, max ${rowA2.variation.similarity.max}`);
  check(!rowA2.flag_reasons.some((f) => f.startsWith('variation:refused')), 'and the refusal reason is gone from the flags', JSON.stringify(rowA2.flag_reasons));

  const approved = await call('brief_approve', { id: briefA, punchline: 'B' }, approver.plaintext);
  const epId = approved.result?.episode_id;
  check(approved.result?.punchline === 'Tides are now on strike.', 'punchline "B" resolves to the drafted line', approved.result?.punchline);
  check(effects.started.length === 1 && effects.started[0] === epId, 'the episode run was started for the new episode');
  const ep = (await client.query('select status, run_id, brief_id, slot_id from episodes where id = $1', [epId])).rows[0];
  check(ep?.run_id === 'run_verify_1' && ep.slot_id === 'S001', 'the episode records its run and slot', JSON.stringify(ep));
  const logA = (await client.query(`select actor_scope, token_id, profile_id, exact_text, payload from authorship_log where action = 'brief_approve' and subject_id = $1`, [briefA])).rows;
  check(logA.length === 1 && logA[0].exact_text === 'Tides are now on strike.' && logA[0].token_id === approver.id && logA[0].profile_id === profileId,
    'authorship_log has the exact punchline, the token and the person');
  check(logA[0]?.payload?.choice === 'B', 'and which choice it was');
  const again = await call('brief_approve', { id: briefA, punchline: 'A' }, approver.plaintext);
  check(again.isError === true && /not pending/.test(again.result?.error ?? ''), 'approving twice is refused', again.result?.error);

  const custom = 'Marlo files the Moon under "Drifting, 3.8 cm a year".';
  const rej = await call('brief_reject', { id: briefB, reason: 'Too close to S001 — save for the bank.' }, approver.plaintext);
  check(rej.result?.status === 'rejected', 'brief_reject rejects');
  const logB = (await client.query(`select exact_text from authorship_log where action = 'brief_reject' and subject_id = $1`, [briefB])).rows;
  check(logB[0]?.exact_text === 'Too close to S001 — save for the bank.', 'the rejection reason is logged verbatim');
  void custom;

  let appendOnly = false;
  try {
    await client.query('update authorship_log set exact_text = $1', ['edited']);
  } catch (err) {
    appendOnly = /append-only/.test(err.message);
  }
  check(appendOnly, 'authorship_log refuses UPDATE');

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. The cut gate
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n6. cut_approve (approver)\n');
  // Seed what the episode run produces up to the gate: a script, a final render, the token.
  const { rows: cc } = await client.query(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 'Moon', 'Pip loses it', 'bureau-v1', 'in_production') returning id`, [BUREAU_CHANNEL_ID]);
  const { rows: ss } = await client.query(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'hook', '[]', 'vo', 'test', 'h') returning id`, [cc[0].id]);
  const { rows: rr } = await client.query(`insert into renders (script_id, variant_group_id, variant_label, format, width, height, status, layer) values ($1, gen_random_uuid(), 'A', 'shorts_9x16', 1080, 1920, 'ready', 'composite') returning id`, [ss[0].id]);
  await client.query(`update episodes set status = 'awaiting_cut', script_id = $2, final_render_id = $3, cut_wait_token = 'waitpoint_verify' where id = $1`, [epId, ss[0].id, rr[0].id]);

  const cut = await call('cut_approve', { id: epId, note: 'Ship it.' }, approver.plaintext);
  check(cut.result?.decision === 'pass' && cut.result?.run_woken === true, 'cut_approve passes and wakes the run', JSON.stringify(cut.result));
  const review = (await client.query('select decision, reviewer_id, render_id from reviews where id = $1', [cut.result?.review_id])).rows[0];
  check(review?.decision === 'pass' && review.reviewer_id === profileId && review.render_id === rr[0].id, 'the review is a pass, by the token’s person, on the final render');
  check(effects.woken[0]?.token === 'waitpoint_verify' && effects.woken[0]?.output?.approved === true, 'the cut gate token was completed with approved=true');
  check((await client.query('select status from episodes where id = $1', [epId])).rows[0].status === 'cut_approved', 'the episode is cut_approved');

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Caps, kill switch, scheduling — asserted at their consumers
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n7. caps_set, kill_switch, mark_scheduled\n');
  const caps = await call('caps_set', { changes: { per_short_cap_inr: 140, daily_publish_cap: 1 } }, approver.plaintext);
  check(Number(caps.result?.policy?.per_short_cap_inr) === 140, 'caps_set changes the cap');
  const capsLog = (await client.query(`select exact_text from authorship_log where action = 'caps_set'`)).rows[0];
  check(JSON.parse(capsLog.exact_text).per_short_cap_inr === 140, 'caps_set logs the exact change');
  const badCap = await call('caps_set', { changes: { kill_switch: true } }, approver.plaintext);
  check(badCap.isError === true && /not a cap/.test(badCap.result?.error ?? ''), 'caps_set cannot reach the kill switch', badCap.result?.error);

  await client.query(`insert into gen_jobs (episode_id, render_route, provider, model, params, duration_s, idempotency_key) values ($1, 'character_beat', 'higgsfield', 'm', '{}', 4, 'verify-killed')`, [epId]);
  const killNoReason = await call('kill_switch', { on: true }, approver.plaintext);
  check(killNoReason.isError === true, 'the kill switch needs a reason to go on');
  await call('kill_switch', { on: true, reason: 'verify: stop everything' }, approver.plaintext);
  const claimedKilled = (await client.query(`select * from claim_gen_jobs('higgsfield', 'verify', 5)`)).rows.length;
  check(claimedKilled === 0, 'with the kill switch on, the queue hands out nothing', `${claimedKilled}`);

  const { rows: pub } = await client.query(
    `insert into publications (render_id, channel_id, review_id, title, episode_id, slot_id, bundle) values ($1, $2, $3, 'Pip lost the Moon', $4, 'S001', '{"video_key": "renders/x.mp4"}') returning id`,
    [rr[0].id, BUREAU_CHANNEL_ID, cut.result?.review_id, epId],
  );
  const killed = await call('mark_scheduled', { id: pub[0].id, at: '2026-10-19T12:30:00Z' }, approver.plaintext);
  check(killed.isError === true && /kill switch/.test(killed.result?.error ?? ''), 'publishing is refused while the switch is on', killed.result?.error);

  await call('kill_switch', { on: false }, approver.plaintext);
  const claimed = (await client.query(`select * from claim_gen_jobs('higgsfield', 'verify', 5)`)).rows.length;
  check(claimed === 1, 'switched off, the queue hands the job out', `${claimed}`);
  const killLog = (await client.query(`select action, exact_text from authorship_log where action like 'kill_switch%' order by occurred_at`)).rows;
  check(killLog.length === 2 && killLog[0].exact_text === 'verify: stop everything', 'both flips are logged, the reason verbatim');

  const sched = await call('mark_scheduled', { id: pub[0].id, at: '2026-10-19T12:30:00Z' }, approver.plaintext);
  check(sched.result?.publication?.status === 'scheduled', 'mark_scheduled schedules a reviewed bundle');
  const { rows: pub2 } = await client.query(
    `insert into publications (render_id, channel_id, review_id, title, slot_id) values ($1, $2, $3, 'Same day', 'S001') returning id`,
    [rr[0].id, BUREAU_CHANNEL_ID, cut.result?.review_id],
  );
  const capHit = await call('mark_scheduled', { id: pub2[0].id, at: '2026-10-19T14:00:00Z' }, approver.plaintext);
  check(capHit.isError === true && /daily publish cap/.test(capHit.result?.error ?? ''), 'a second Short the same day hits the daily publish cap', capHit.result?.error);

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Resources and the checks
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n8. Resources and checks\n');
  const resList = (await rpc('resources/list', {}, agent.plaintext)).body.result.resources.map((r) => r.uri);
  check(['kiln://bible/characters', 'kiln://policy/rubric', 'kiln://calendar/next-14', 'kiln://series/pip'].every((u) => resList.includes(u)), 'the four resource kinds are listed');
  const pipSeries = JSON.parse((await rpc('resources/read', { uri: 'kiln://series/pip' }, agent.plaintext)).body.result.contents[0].text);
  check(pipSeries.id === 'pip' && pipSeries.serialised === true, 'kiln://series/pip reads the series file');
  const cast = JSON.parse((await rpc('resources/read', { uri: 'kiln://bible/characters' }, agent.plaintext)).body.result.contents[0].text);
  check(cast.characters.length === 8 && cast.characters.every((c) => c.voice.provider === 'runway'), 'the bible serves eight characters on Runway presets');
  check((await rpc('resources/read', { uri: 'kiln://nope' }, agent.plaintext)).body.error?.code === -32602, 'an unknown resource is a protocol error');

  const lintBad = await call('policy_lint', { script_text: 'Pip: Elon Musk says buy the dip in crypto.', fact: [] }, agent.plaintext);
  const rules = (lintBad.result?.violations ?? []).map((v) => v.rule).sort();
  check(lintBad.result?.status === 'fail' && JSON.stringify(rules) === JSON.stringify(['fact_count', 'finance_advice', 'real_living_people']), 'policy_lint names exactly the broken rules', rules.join(','));

  const variation = await call('variation_check', { brief: { series: 'incident', lead: 'pip', desk: 'gravity', premise_type: 'what_if_removed', structure_variant: 'ladder_hourly', ending_type: 'callback_gag', music_bed: 'bed_typewriter_shuffle', hook_archetype: 'story_open', on_date: '2026-10-19' } }, agent.plaintext);
  check(variation.result?.status === 'fail' && variation.result.failing_axes.length === 1 && variation.result.failing_axes[0].differing === 0, 'a clone of the approved brief fails variation on all 7 axes', JSON.stringify(variation.result?.failing_axes));

  // The tool reads from today; the calendar is fixed to 2026 dates. So the tool is driven for
  // shape, and the same function is driven with a fixed "today" for the S001 assertion —
  // otherwise this check would silently start failing (or worse, pass vacuously) next year.
  const calTool = await call('calendar_upcoming', { days: 14 }, agent.plaintext);
  // The bank count's other side comes from the CSV, not from the table the tool reads.
  const { readFileSync } = await import('node:fs');
  const csvBank = readFileSync(new URL('../data/kiln-topic-calendar.csv', import.meta.url), 'utf8').split('\n').filter((l) => /^B\d{2},/.test(l)).length;
  check(Array.isArray(calTool.result?.slots) && calTool.result.bank_slots === csvBank, 'calendar_upcoming answers, with the bank count from the calendar file', `bank ${calTool.result?.bank_slots} vs csv ${csvBank}`);
  const { calendarUpcoming } = require(`${BUILD}/bureau/read.js`);
  const cal = await calendarUpcoming(db, BUREAU_CHANNEL_ID, 30, new Date('2026-10-10T00:00:00Z'));
  const s001 = cal.slots.find((s) => s.id === 'S001');
  check(s001?.production_status === 'scheduled', 'the calendar reads S001’s production state from the episode', s001?.production_status ?? JSON.stringify(cal).slice(0, 400));
} catch (err) {
  bad('harness threw', err.stack);
} finally {
  server.close();
  await scratch.release();
}

console.log(failures ? `\n${failures} FAILED\n` : '\nAll Bureau control-plane checks passed.\n');
process.exit(failures ? 1 : 0);
