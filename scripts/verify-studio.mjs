#!/usr/bin/env node
/**
 * Exercise the Studio lane for real: a session is a front end to the pipeline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   §1–3  The MCP server answers the protocol over a real HTTP socket, and its authentication
 *         holds: no token, a forged signature, an unknown session and a stopped session are
 *         four distinct refusals. A session cannot open without a cap or without a channel.
 *
 *   §4    The legacy lane is unreachable. `generate_shot`, `stitch_rough_cut`,
 *         `check_generation` and `list_session_shots` are not on the surface (a JSON-RPC
 *         unknown-tool error, not a refusal), no Studio module requires the stage-4/5 tasks,
 *         and at the end of the run no script, shot or generation exists — every tool,
 *         including approval, ran without one. The recipe tools still work.
 *
 *   §5–6  A session drafts a brief for ITS channel in a chosen type: the 3D explainer through
 *         its own writer (key motion) on Built Like That, and the illustrated type through the
 *         ordinary writer on the Bureau. LOAD-BEARING: the brief row, its tags, its author
 *         token and its two ledger rows are read from the database, which `createBriefs` and
 *         the router wrote — and the ledger rows carry the session, so the session total the
 *         cap is enforced against moves by exactly the writer's tokens × the rate card.
 *
 *   §7    The brief prices against the cap: every type and motion level, the verdict
 *         recomputed here from a cap read straight from `channel_policy`, and a lowered cap
 *         turns every priced option over_cap. Unpriced is never ₹0.
 *
 *   §8    Approval stays the approver's. The session's tool list has no decision tool, the
 *         agent token it drafts with is refused by `approveBrief` AND by the database
 *         function, and the brief stays pending. Then the approver's approval of THAT brief
 *         asks the effects stub to start `20-episode` for the episode it created — the run the
 *         Bureau path takes — and Approvals pre-selects the type the session asked for.
 *
 *   §9    The session follows it: episode_status, the accepting AND refusing halves of
 *         shot_regenerate (a clip re-rolls from its last job; a picture is the approver's),
 *         open_cut_and_bundle, and the session read the Studio screen renders.
 *
 *   §10   Spend is derived from the ledger; the cap stops a turn and a draft.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES NOT PROVE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   That Anthropic can reach `/api/mcp` (the connector dials from Anthropic's side and needs
 *   a public hostname), that the real writer produces a draft the schema accepts (the writer
 *   here is a stub returning the 0052 fixture), or anything about the episode run past its
 *   start — `20-episode` is driven by `verify:episode` / `verify:engineered`, not here.
 *
 * Usage: node scripts/verify-studio.mjs <db-url>
 *        ANTHROPIC_API_KEY=... enables §11, one real conversational turn (no drafting).
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);

// `server-only` throws outside the RSC graph; seeding the cache neutralises the guard for
// this process without editing the modules under test.
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-studio.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { serveMcp } = require(`${BUILD}/studio/serve.js`);
const { mintSessionToken } = require(`${BUILD}/studio/token.js`);
const { PROTOCOL_VERSION } = require(`${BUILD}/studio/mcp.js`);
const { startSession, runTurn } = require(`${BUILD}/studio/session.js`);
const { readSession } = require(`${BUILD}/studio/read.js`);
const { requestedFromTags } = require(`${BUILD}/studio/front-end.js`);
const { approveBrief } = require(`${BUILD}/bureau/control.js`);
const { mintBureauToken } = require(`${BUILD}/bureau/tokens.js`);
const { BUREAU_CHANNEL_ID: BUREAU } = require(`${BUILD}/fixtures/seed-channel.js`);
const { createChannel, importFolderBible } = require(`${BUILD}/channels/bible-admin.js`);
const { BRIEF_SYSTEM, JUDGE_SYSTEM } = require(`${BUILD}/prompts/20-bureau.v1.js`);
const { ENGINEERED_SYSTEM } = require(`${BUILD}/prompts/23-engineered.v1.js`);

const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');
const { stubEmbedder } = await import('./lib/stub-embedder.mjs');

const SECRET = 'verify-studio-secret-not-a-real-one';
const FX = 88;
const APP = 'https://kiln.test';

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};
const check = (c, l, d = '') => (c ? ok(l, d) : bad(l, d));

const scratch = await scratchDatabase(dbUrl, 'studio');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;

// ── Recording effects: what the lane asked the outside world to do ──────────
const effects = {
  started: [],
  notified: [],
  redraws: [],
  async startEpisode(id) {
    this.started.push(id);
    return `run_verify_${this.started.length}`;
  },
  async completeWaitToken() {},
  async startRedraw(input) {
    this.redraws.push(input);
    return 'run_redraw';
  },
  async notify(channelId, kind, text) {
    this.notified.push({ channelId, kind, text });
  },
  async embedderFor() {
    return stubEmbedder;
  },
};

// ── The model: a stub that answers each writer by its system prompt ────────
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/engineered-draft.json', import.meta.url), 'utf8'));
const decodedEngineered = {
  ...FIXTURE,
  beats: FIXTURE.beats.map((b) => ({
    ...b,
    graphics: {
      badge: b.graphics.badge ?? null,
      verdict: b.graphics.verdict ? { pass: b.graphics.verdict.pass, text: b.graphics.verdict.text, sub: b.graphics.verdict.sub ?? null } : null,
      callouts: (b.graphics.callouts ?? []).map((c) => ({ label: c.label, x: c.x ?? null, y: c.y ?? null })),
      meters: (b.graphics.meters ?? []).map((m) => ({ label: m.label, from: m.from ?? null, to: m.to ?? null, value: m.value ?? null, unit: m.unit })),
      keyword: b.graphics.keyword ?? null,
    },
  })),
};
const bureauDraft = {
  lead_character: 'pip',
  supporting_characters: ['marlo'],
  desk: 'gravity',
  premise: 'Pip misplaces the Moon and the tides file a formal complaint by Friday.',
  premise_type: 'what_if_removed',
  structure_variant: 'ladder_hourly',
  ending_type: 'callback_gag',
  music_bed: 'bed_typewriter_shuffle',
  hook_archetype: 'story_open',
  catchphrase_used: null,
  punchlines: ['The Moon is in Lost Property.', 'Tides are now on strike.', 'Marlo stamps it: "Gravitationally Unavailable".'],
  beat_sheet: [{ beat_id: 'cold_open', summary: 'Empty sky, Pip with a clipboard.' }, { beat_id: 'stakes', summary: 'Tides stop.' }],
  script_text: 'Pip: I may have misplaced the Moon.\nMarlo: The Moon holds the tides. No Moon, smaller tides by Friday.\nPip: How much smaller?\nMarlo: About a third of what you are used to.',
  shot_list: [
    { beat_id: 'cold_open', route: 'overlay', description: 'Blueprint sky, empty orbit ring', duration_s: 6, characters: [], realistic: false },
    { beat_id: 'stakes', route: 'character_beat', description: 'Pip turns, clipboard falls', duration_s: 4, characters: ['pip'], realistic: false },
    { beat_id: 'mechanism_1', route: 'overlay', description: 'Tidal bulge diagram', duration_s: 10, characters: [], realistic: false },
  ],
  fact: { claim: "The Moon's gravity is the main cause of Earth's ocean tides.", source_url: 'https://oceanservice.noaa.gov/facts/moon-tides.html', source_title: 'NOAA' },
  titles: [
    { text: 'Pip lost the Moon', hook_archetype: 'story_open' },
    { text: 'What if the Moon vanished?', hook_archetype: 'question' },
    { text: 'Tides drop by two thirds', hook_archetype: 'number_claim' },
  ],
  pinned_comment: 'Which desk should Pip break next?',
};
const WRITER_USAGE = { input_tokens: 1500, output_tokens: 3000 };
const llmCalls = [];
const llmClient = {
  messages: {
    parse: async (body) => {
      const system = String(body.system ?? '');
      const user = String(body.messages[0].content);
      llmCalls.push({ system, model: body.model });
      if (system === ENGINEERED_SYSTEM) return { usage: WRITER_USAGE, stop_reason: 'end_turn', parsed_output: decodedEngineered };
      if (system === BRIEF_SYSTEM) return { usage: WRITER_USAGE, stop_reason: 'end_turn', parsed_output: bureauDraft };
      if (system === JUDGE_SYSTEM) {
        const n = [...user.matchAll(/^\d+\. /gm)].length;
        return { usage: { input_tokens: 300, output_tokens: 60 }, stop_reason: 'end_turn', parsed_output: { verdicts: Array.from({ length: n }, (_, i) => ({ question: `q${i}`, violation: false, reason: 'fine' })) } };
      }
      throw new Error(`stub model: no answer for system prompt ${system.slice(0, 60)}`);
    },
  },
};

// ── A real HTTP server over the real handler ────────────────────────────────
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Body is not JSON.' } }));
      return;
    }
    try {
      const result = await serveMcp(
        { authorization: req.headers.authorization ?? null, body },
        { db, secret: SECRET, bureau: effects, studioLlm: async () => ({ apiKey: 'test-llm-key', client: llmClient }), appUrl: APP },
      );
      res.writeHead(result.status, { 'content-type': 'application/json', ...(result.headers ?? {}) });
      res.end(result.body === null ? '' : JSON.stringify(result.body));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'handler threw', detail: err.message }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ENDPOINT = `http://127.0.0.1:${server.address().port}/api/mcp`;

async function rpc(method, params, token, id = randomUUID()) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
async function callTool(name, args, token) {
  const { body } = await rpc('tools/call', { name, arguments: args }, token);
  return body?.result?.structuredContent ?? body;
}

console.log('\nStudio lane verification\n');
console.log(`  MCP server on ${ENDPOINT}\n`);

try {
  // ═══════════════════════════════════════════════════════════════════════════
  // 0. The world: inputs only
  // ═══════════════════════════════════════════════════════════════════════════
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'studio-harness@invalid.test', $1) returning id`, [FX]);
  await q(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('runway', 'video', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);
  await q(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('anthropic', 'llm', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);
  await importFolderBible(db, { channelId: BUREAU, slug: 'bureau-of-reality', by: 'verify:studio' });
  // The 3D explainer's clip recipe, active — what bundle 10b does on the hosted project.
  await q(`update prompts set is_active = true, retired_at = null, retired_reason = null where name = 'engineered-picture-clip-gen4-turbo' and version = 1`);
  const made = await createChannel(db, { scope: 'approver', profileId: prof.id, via: 'verify:studio' }, { name: 'Built Like That', slug: 'built-like-that', handle: '@BuiltLikeThat', niche: 'How everyday engineering works', targets: ['youtube'], template: 'built-like-that' });
  if (!made.ok) throw new Error(`createChannel: ${made.refused}`);
  const BLT = made.channelId;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. Opening a session
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('1. Opening a session\n');
  const capless = await startSession(db, { title: 'no cap', channelId: BLT, spendCapInr: 0 });
  check(!capless.ok && capless.code === 'no_spend_cap', 'a session without a cap is refused', capless.code);
  const channelless = await startSession(db, { title: 'no channel', channelId: null, spendCapInr: 50 });
  check(!channelless.ok && channelless.code === 'no_channel', 'a session without a channel is refused — it would have nothing to draft for', channelless.code);
  const started = await startSession(db, { title: 'verify-studio', channelId: BLT, spendCapInr: 100 });
  if (!started.ok) throw new Error(`a session opens: ${started.detail}`);
  const sessionId = started.sessionId;
  const [sessRow] = await q('select channel_id, model from studio_sessions where id = $1', [sessionId]);
  check(sessRow.channel_id === BLT, 'a session opens on its channel', `${sessionId.slice(0, 8)} → Built Like That`);
  check(sessRow.model === 'claude-opus-5-5', 'the session model is the router’s judge tier (Opus)', sessRow.model);
  const token = mintSessionToken(sessionId, SECRET);

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. The protocol, over the socket
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n2. The MCP protocol over real HTTP\n');
  {
    const { status, body, headers } = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION }, token);
    check(status === 200 && body?.result?.serverInfo?.name === 'kiln-studio', 'initialize', `protocolVersion=${body?.result?.protocolVersion}`);
    check(headers.get('mcp-protocol-version') === PROTOCOL_VERSION, 'protocol version header');
  }
  // The expected list is a literal here, not read from STUDIO_TOOLS: comparing the served list
  // with the module's own array would pass whatever the module contained.
  const EXPECTED = ['brief_get', 'channel_overview', 'draft_brief', 'episode_status', 'list_prompt_recipes', 'open_cut_and_bundle', 'price_brief', 'save_prompt_recipe', 'shot_regenerate', 'trends_recent'];
  {
    const { body } = await rpc('tools/list', {}, token);
    const names = (body?.result?.tools ?? []).map((t) => t.name).sort();
    check(JSON.stringify(names) === JSON.stringify(EXPECTED), 'tools/list is exactly the pipeline front end plus the recipe tools', names.join(', '));
    check((body?.result?.tools ?? []).every((t) => t.inputSchema?.type === 'object'), 'every tool carries a JSON Schema');
  }
  {
    const { status, body } = await rpc('notifications/initialized', {}, token, null);
    check(status === 202 && body === null, 'a notification gets no response', `${status}`);
  }
  {
    const { body } = await rpc('tools/kill_everything', {}, token);
    check(body?.error?.code === -32601, 'an unknown method is a JSON-RPC error');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. Authentication
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n3. Authentication\n');
  check((await rpc('tools/list', {}, null)).status === 401, 'no token is refused');
  check((await rpc('tools/list', {}, mintSessionToken(sessionId, 'a different secret'))).status === 401, 'a forged signature is refused');
  check((await rpc('tools/list', {}, mintSessionToken(randomUUID(), SECRET))).status === 401, 'a valid signature over an unknown session is refused');
  {
    const other = await startSession(db, { title: 'other', channelId: BLT, spendCapInr: 10 });
    await q(`update studio_sessions set status = 'archived', stopped_reason = 'archived by the operator' where id = $1`, [other.sessionId]);
    const { status, body } = await rpc('tools/list', {}, mintSessionToken(other.sessionId, SECRET));
    check(status === 403 && body?.error === 'session_not_active', 'a stopped session refuses its own token', body?.detail);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. The legacy lane is unreachable; the recipe tools stay
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n4. Nothing in the Studio reaches the legacy generate lane\n');
  for (const name of ['generate_shot', 'stitch_rough_cut', 'check_generation', 'list_session_shots']) {
    const { body } = await rpc('tools/call', { name, arguments: { description: 'a wide shot of a city at dusk', duration_s: 4 } }, token);
    check(body?.error?.code === -32602, `${name} is not on the surface`, body?.error?.message ?? JSON.stringify(body).slice(0, 120));
  }
  {
    // The module graph, from the compiled output the server above actually loaded. Positive
    // control first: the same scan must find a require that IS there, or an empty result
    // would be a broken instrument rather than a finding.
    const dir = `${BUILD}/studio`;
    const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
    const src = Object.fromEntries(files.map((f) => [f, readFileSync(`${dir}/${f}`, 'utf8')]));
    check(/require\("\.\.\/bureau\/briefs"\)/.test(src['tools.js'] ?? ''), 'positive control: the scan sees tools.js require bureau/briefs');
    // Requires only — a comment naming the old path (session.ts explains a ledger fix found
    // in generate/submit.ts) is history, not a dependency.
    const requires = (f) => [...src[f].matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    const legacy = files.filter((f) => requires(f).some((r) => /trigger\/0[45]-|^\.\/enqueue$|^\.\/materialise$|generate\/(submit|enqueue)$/.test(r)));
    check(legacy.length === 0, 'no Studio module requires stage 4/5, the old enqueue or materialise', legacy.join(', ') || 'none');
    check(!existsSync(new URL('../src/lib/studio/enqueue.ts', import.meta.url)) && !existsSync(new URL('../src/lib/studio/materialise.ts', import.meta.url)), 'studio/enqueue.ts and studio/materialise.ts are gone from the source');
  }
  {
    const result = await callTool('list_prompt_recipes', {}, token);
    check(result?.ok === true && typeof result.count === 'number', 'list_prompt_recipes still answers', `${result?.count} active`);
    const refused = await callTool('save_prompt_recipe', { name: 'broken recipe', driver: 'someone', model: 'some-model', template: 'a {{subject}} in a {{place}}', params: '{"motion":"push_in"}', tags: ['establishing'] }, token);
    check(refused?.refused === true && /subject|place|placeholder/i.test(JSON.stringify(refused.blockers)), 'save_prompt_recipe refuses an unfillable template');
    const saved = await callTool('save_prompt_recipe', { name: 'verify establishing', driver: 'someone', model: 'some-model', template: 'establishing shot: {{description}}, {{duration}}s', params: '{"motion":"push_in","aspect":"9:16"}', tags: ['establishing'] }, token);
    check(saved?.ok === true && saved.version === 1, 'save_prompt_recipe accepts a fillable one', saved?.name);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. The channel, and a 3D explainer drafted for it
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n5. A session drafts a 3D explainer brief for its channel\n');
  const [policy] = await q('select per_short_cap_inr from channel_policy where channel_id = $1', [BLT]);
  const CAP = Number(policy.per_short_cap_inr);
  {
    const ov = await callTool('channel_overview', {}, token);
    const evo = ov?.series?.find((s) => s.id === 'evolution');
    check(ov?.ok === true && ov.channel.id === BLT && evo?.default_type === 'engineered' && evo.default_motion === 'key', 'channel_overview answers for the session’s channel: evolution defaults to the 3D explainer, key motion', JSON.stringify(evo && [evo.default_type, evo.default_motion]));
    check(ov?.caps?.per_short_cap_inr === CAP, 'it reports the per-Short cap channel_policy holds', `₹${ov?.caps?.per_short_cap_inr} vs ₹${CAP}`);
    check(Array.isArray(ov?.video_types) && ov.video_types.map((t) => t.id).join() === 'illustrated,diagram,cinematic,characters,engineered', 'every video type is offered', ov?.video_types?.map((t) => t.id).join());
  }

  const ledgerBefore = Number((await q('select count(*)::int n from cost_ledger'))[0].n);
  const draft = await callTool('draft_brief', { video_type: 'engineered', motion: 'key', series: 'evolution', topic: 'Train couplers', hook: 'You used to have to stand between the wagons.' }, token);
  check(draft?.ok === true && typeof draft.brief_id === 'string', 'draft_brief creates a brief', draft?.ok ? draft.brief_id.slice(0, 8) : JSON.stringify(draft).slice(0, 300));
  const briefId = draft?.brief_id;
  check(llmCalls.length >= 1 && llmCalls[0].system === ENGINEERED_SYSTEM && llmCalls[0].model === 'claude-sonnet-5-5', 'the 3D explainer’s own writer drafted it, on the router’s writer tier', llmCalls[0]?.model);

  // LOAD-BEARING: everything below is read from rows createBriefs and the router wrote.
  const [row] = await q(`select b.channel_id, b.status, b.slot_id, b.series, b.tags, b.created_by, b.estimate_inr, b.hero_objects, t.name as token_name, t.scope as token_scope
                           from briefs b left join mcp_tokens t on t.id = b.created_by_token where b.id = $1`, [briefId]);
  check(row?.channel_id === BLT && row.status === 'pending' && row.slot_id === null && row.series === 'evolution', 'the row: Built Like That, pending, unslotted, evolution', JSON.stringify(row && [row.status, row.slot_id, row.series]));
  check(row && row.tags.includes(`studio:${sessionId}`) && row.tags.includes('format:engineered') && row.tags.includes('motion:key') && row.tags.includes('drafted:studio') && !row.tags.includes('drafted:server'), 'tagged with the session and the type it was asked for', JSON.stringify(row?.tags));
  check(row?.created_by === 'agent' && row.token_scope === 'agent' && row.token_name === 'Studio (Opus session)', 'drafted by the Studio’s AGENT token — it can draft, never decide', `${row?.created_by} / ${row?.token_name}`);
  check(Array.isArray(row?.hero_objects) && row.hero_objects.length === FIXTURE.hero_objects.length, 'the 3D explainer’s hero objects ride along', `${row?.hero_objects?.length}`);
  const [authorship] = await q(`select actor_scope, action from authorship_log where subject_id = $1`, [briefId]);
  check(authorship?.action === 'brief_create' && authorship.actor_scope === 'agent', 'authorship_log records the draft as the agent', JSON.stringify(authorship));

  const writerRows = await q(`select unit, quantity::int as quantity, cost_inr, channel_id, studio_session_id, stage from cost_ledger where stage = '20-brief' and studio_session_id = $1 order by unit`, [sessionId]);
  check(writerRows.length === 2 && writerRows.every((r) => r.channel_id === BLT) && writerRows.find((r) => r.unit === 'input_token')?.quantity === 1500 && writerRows.find((r) => r.unit === 'output_token')?.quantity === 3000,
    'the writer’s two ledger rows carry the channel AND the session, at the stub’s exact token counts (rule 5)', JSON.stringify(writerRows.map((r) => [r.unit, r.quantity])));
  {
    // Independent route to the session total: the rate card's own rows × the stub's usage × FX.
    const rates = Object.fromEntries((await q(`select unit, unit_cost from rate_card where driver = 'anthropic' and model = 'claude-sonnet-5-5' and endpoint = '/v1/messages' and is_verified order by effective_from desc`)).reverse().map((r) => [r.unit, Number(r.unit_cost)]));
    const expected = (1500 * rates.input_token + 3000 * rates.output_token) * FX;
    const [s] = await q('select cost_inr from studio_sessions where id = $1', [sessionId]);
    check(Math.abs(Number(s.cost_inr) - expected) < 0.0001, 'the session total the cap reads is exactly the writer’s tokens × the rate card × FX', `₹${Number(s.cost_inr).toFixed(4)} vs ₹${expected.toFixed(4)}`);
  }
  check(effects.notified.some((n) => n.channelId === BLT && n.kind === 'briefs_pending'), 'the approver is told a brief is waiting');
  check(draft?.approval?.links?.approvals === `${APP}/bureau/approvals?id=${briefId}`, 'the result hands off to Approvals with a tappable link', draft?.approval?.links?.approvals);

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. The ordinary writer, on the other channel, and refusals that spend nothing
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n6. Another channel, another type\n');
  const bureauSession = await startSession(db, { title: 'bureau', channelId: BUREAU, spendCapInr: 100 });
  const bureauToken = mintSessionToken(bureauSession.sessionId, SECRET);
  {
    const calls = llmCalls.length;
    const refused = await callTool('draft_brief', { video_type: 'illustrated', motion: 'full', series: 'incident', topic: 'The Moon goes missing' }, bureauToken);
    check(refused?.refused === true && refused.blockers.some((b) => b.code === 'motion_without_engineered') && llmCalls.length === calls, 'motion with a type that has none is refused before any model call', refused?.blockers?.map((b) => b.code).join());
    const noTopic = await callTool('draft_brief', { video_type: 'illustrated' }, bureauToken);
    check(noTopic?.refused === true && noTopic.blockers.some((b) => b.code === 'no_topic') && llmCalls.length === calls, 'no slot and no topic is refused before any model call');
  }
  const illus = await callTool('draft_brief', { video_type: 'illustrated', series: 'incident', topic: 'The Moon goes missing' }, bureauToken);
  check(illus?.ok === true, 'an illustrated brief drafts on the Bureau', illus?.ok ? illus.brief_id.slice(0, 8) : JSON.stringify(illus).slice(0, 300));
  check(llmCalls.some((c) => c.system === BRIEF_SYSTEM), 'through the ordinary writer, not the 3D explainer’s');
  const [illusRow] = await q('select channel_id, tags from briefs where id = $1', [illus?.brief_id]);
  check(illusRow?.channel_id === BUREAU && illusRow.tags.includes('format:illustrated') && !illusRow.tags.some((t) => t.startsWith('motion:')), 'on the Bureau, tagged illustrated, no motion', JSON.stringify(illusRow?.tags));
  {
    const other = await callTool('brief_get', { brief_id: briefId }, bureauToken);
    check(other?.refused === true && other.blockers[0].code === 'not_this_session', 'a session cannot read another session’s brief');
    const otherPrice = await callTool('price_brief', { brief_id: briefId }, bureauToken);
    check(otherPrice?.refused === true, 'nor price it');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. Priced against the cap
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n7. Every type and motion level, against the per-Short cap\n');
  const verdictFor = (inr, cap) => (inr === null ? 'unpriced' : cap === null ? 'no_cap_set' : inr <= cap ? 'within_cap' : 'over_cap');
  {
    const p = draft?.pricing;
    check(p?.cap_inr === CAP, 'the cap is channel_policy’s', `₹${p?.cap_inr}`);
    check(p?.requested?.format === 'engineered' && p.requested.motion === 'key', 'the price is quoted for the type and motion asked for', JSON.stringify(p?.requested));
    check(p?.formats?.length === 5 && p.formats.every((f) => f.verdict === verdictFor(f.inr, CAP)), 'every type’s verdict agrees with its ₹ and the cap', p?.formats?.map((f) => `${f.format}:${f.inr === null ? '—' : f.inr.toFixed(0)}:${f.verdict}`).join(' '));
    const key = p?.motions?.find((m) => m.motion === 'key');
    const full = p?.motions?.find((m) => m.motion === 'full');
    check(key && full && typeof key.inr === 'number' && typeof full.inr === 'number' && key.verdict === verdictFor(key.inr, CAP) && full.verdict === verdictFor(full.inr, CAP), 'key and full are both priced, each with its verdict', `key ₹${key?.inr?.toFixed(2)} ${key?.verdict} · full ₹${full?.inr?.toFixed(2)} ${full?.verdict}`);
    check(key && full && full.clips_wanted >= key.clips_wanted, 'full motion asks for at least as many clips as key', `${key?.clips_wanted} vs ${full?.clips_wanted}`);
    check(p?.formats?.every((f) => f.inr !== 0), 'no option is quoted as ₹0 — unpriced stays null');
    const again = await callTool('price_brief', { brief_id: briefId }, token);
    check(again?.ok === true && JSON.stringify(again.pricing.formats) === JSON.stringify(p?.formats), 'price_brief quotes what draft_brief quoted');
    await q('update channel_policy set per_short_cap_inr = 1 where channel_id = $1', [BLT]);
    const low = await callTool('price_brief', { brief_id: briefId }, token);
    const priced = low?.pricing?.formats?.filter((f) => f.inr !== null) ?? [];
    check(low?.pricing?.cap_inr === 1 && priced.length > 0 && priced.every((f) => f.verdict === 'over_cap'), 'a ₹1 cap turns every priced option over_cap', `${priced.length} priced`);
    await q('update channel_policy set per_short_cap_inr = $2 where channel_id = $1', [BLT, CAP]);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Approval stays the approver's
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n8. Approval is the approver’s; approving starts 20-episode\n');
  {
    const { body } = await rpc('tools/call', { name: 'brief_approve', arguments: { id: briefId, punchline: 'A' } }, token);
    check(body?.error?.code === -32602, 'the session has no approve tool', body?.error?.message);
    const [agentTok] = await q(`select id from mcp_tokens where name = 'Studio (Opus session)' and channel_id = $1`, [BLT]);
    const studioAgent = { id: agentTok.id, name: 'Studio (Opus session)', scope: 'agent', channelId: BLT, profileId: null };
    let tsRefused = '';
    try {
      await approveBrief(db, studioAgent, effects, { brief_id: briefId, punchline: 'A' });
    } catch (err) {
      tsRefused = err.message;
    }
    check(/approver scope/.test(tsRefused), 'its agent token is refused by approveBrief', tsRefused.slice(0, 80));
    // LOAD-BEARING: the database function refuses it too — the guard that holds if a future
    // caller skips the TypeScript.
    let dbRefused = '';
    try {
      await client.query(`select bureau_brief_approve($1, $2, 'x', 'A', '{}'::jsonb)`, [agentTok.id, briefId]);
    } catch (err) {
      dbRefused = err.message;
    }
    check(/scope|approver/i.test(dbRefused), 'and by bureau_brief_approve in the database', dbRefused.slice(0, 80));
    const [still] = await q('select status from briefs where id = $1', [briefId]);
    check(still.status === 'pending' && effects.started.length === 0, 'the brief is still pending and no run was started');
  }
  const minted = await mintBureauToken(db, { name: 'Sahil', scope: 'approver', channelId: BLT, profileId: prof.id });
  const approver = { id: minted.id, name: 'Sahil', scope: 'approver', channelId: BLT, profileId: prof.id };
  const [tagsRow] = await q('select tags from briefs where id = $1', [briefId]);
  const asked = requestedFromTags(tagsRow.tags);
  check(asked.format === 'engineered' && asked.motion === 'key', 'Approvals pre-selects the type and motion the session asked for', JSON.stringify(asked));
  const approved = await approveBrief(db, approver, effects, { brief_id: briefId, punchline: 'A', edits: { visual_format: asked.format, motion: asked.motion } });
  const [ep] = await q('select e.id, e.brief_id, e.status, e.run_id, b.approved_edits from episodes e join briefs b on b.id = e.brief_id where e.brief_id = $1', [briefId]);
  check(ep && effects.started.length === 1 && effects.started[0] === ep.id && approved.episode_id === ep.id, 'the approval asks the effects layer to start 20-episode for the episode it created', `${effects.started[0]?.slice(0, 8)} = ${ep?.id?.slice(0, 8)}`);
  check(ep?.run_id === 'run_verify_1', 'and records the run id on it', ep?.run_id);
  check(ep?.approved_edits?.visual_format === 'engineered' && ep.approved_edits.motion === 'key', 'the approval records the 3D explainer at key motion — what planShots reads', JSON.stringify(ep?.approved_edits));

  // ═══════════════════════════════════════════════════════════════════════════
  // 9. Following the episode
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n9. The session follows what it started\n');
  {
    const all = await callTool('episode_status', {}, token);
    check(all?.ok === true && all.episodes.length === 1 && all.episodes[0].id === ep.id && all.episodes[0].status === ep.status, 'episode_status lists the episode the approval started', all?.episodes?.map((e) => `${e.id.slice(0, 8)}:${e.status}`).join());
    const cross = await callTool('episode_status', { episode_id: ep.id }, bureauToken);
    check(cross?.refused === true, 'another session cannot follow it');
    const early = await callTool('open_cut_and_bundle', { episode_id: ep.id }, token);
    check(early?.ok === true && early.cut === 'not assembled yet' && early.bundle === null && early.links.cuts === `${APP}/bureau/cuts?id=${ep.id}`, 'open_cut_and_bundle before the cut: nothing yet, and the links', early?.cut);
    const tooEarly = await callTool('shot_regenerate', { episode_id: ep.id, shot: 0, note: 'tighter on the coupler' }, token);
    check(tooEarly?.refused === true && tooEarly.blockers[0].code === 'reroll_refused' && /no shots yet/.test(tooEarly.blockers[0].detail), 'a re-roll before the run has shots is refused, and says so', tooEarly?.blockers?.[0]?.detail);

    // The run's output, seeded as INPUTS: a script with a clip shot and a picture shot, the clip's
    // generation job, the cut waiting for review. What is asserted is what shot_regenerate writes.
    const [concept] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, 't', 'a', 'v', 'in_production') returning id`, [BLT]);
    const [script] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', '[]', 'v', 'x', 'h') returning id`, [concept.id]);
    const [clip] = await q(`insert into shots (script_id, idx, duration_s, description, status, render_route) values ($1, 0, 2.5, 'coupler closes', 'ready', 'picture_clip') returning id`, [script.id]);
    await q(`insert into shots (script_id, idx, duration_s, description, status, render_route) values ($1, 1, 3, 'cutaway', 'ready', 'still')`, [script.id]);
    const [job] = await q(`insert into gen_jobs (episode_id, shot_id, render_route, provider, model, params, duration_s, idempotency_key) values ($1, $2, 'picture_clip', 'runway', 'gen4_turbo', '{}', 2.5, 'verify-studio-clip') returning id`, [ep.id, clip.id]);
    await q(`update episodes set script_id = $2, status = 'awaiting_cut' where id = $1`, [ep.id, script.id]);

    const reroll = await callTool('shot_regenerate', { episode_id: ep.id, shot: 0, note: 'tighter on the coupler' }, token);
    const [rr] = await q('select reroll_of, reroll_index, note, render_route from gen_jobs where episode_id = $1 and reroll_of is not null', [ep.id]);
    check(reroll?.ok === true && rr?.reroll_of === job.id && rr.reroll_index === 1 && rr.note === 'tighter on the coupler' && rr.render_route === 'picture_clip', 'a clip re-rolls from its last job with the note (the accepting branch)', JSON.stringify(rr));
    const pic = await callTool('shot_regenerate', { episode_id: ep.id, shot: 1, note: 'lighter background' }, token);
    check(pic?.refused === true && /picture/.test(pic.blockers[0].detail) && effects.redraws.length === 0, 'a picture is the approver’s to redraw — refused, nothing started', pic?.blockers?.[0]?.detail?.slice(0, 70));
    const cut = await callTool('open_cut_and_bundle', { episode_id: ep.id }, token);
    check(cut?.ok === true && cut.cut === 'assembled' && cut.status === 'awaiting_cut', 'open_cut_and_bundle once the cut is waiting', cut?.status);

    const read = await readSession(db, sessionId);
    const b = read.ok ? read.detail.briefs.find((x) => x.id === briefId) : null;
    check(read.ok && read.detail.channel?.id === BLT && b?.episode?.id === ep.id && b.episode.status === 'awaiting_cut' && b.videoType === 'engineered' && b.motion === 'key', 'the Studio screen’s read: the brief, its type, and the episode with its live status', b ? `${b.videoType}/${b.motion} → ${b.episode?.status}` : read.detail);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10. Spend: derived from the ledger, and the cap stops
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n10. The cap stops turns and drafts\n');
  {
    const capped = await startSession(db, { title: 'at the ceiling', channelId: BLT, spendCapInr: 1 });
    const cappedToken = mintSessionToken(capped.sessionId, SECRET);
    await q(`insert into cost_ledger (driver, stage, entry_kind, studio_session_id, unit, quantity, cost_usd, cost_inr, usd_inr_rate, idempotency_key) values ('anthropic','studio','reconcile',$1,'output_token',5000,0.125,2.50,88,$2)`, [capped.sessionId, `verify:${capped.sessionId}:over`]);
    const [s] = await q('select cost_inr from studio_sessions where id = $1', [capped.sessionId]);
    check(Number(s.cost_inr) === 2.5, 'cost_inr is the sum of the ledger rows (0017’s trigger)', `₹${s.cost_inr}`);
    const calls = llmCalls.length;
    const draftOver = await callTool('draft_brief', { video_type: 'engineered', series: 'evolution', topic: 'Escalator combs' }, cappedToken);
    check(draftOver?.refused === true && draftOver.blockers.some((b) => b.code === 'session_cap') && llmCalls.length === calls, 'a draft over the session cap is refused before any model call', draftOver?.blockers?.map((b) => b.code).join());
    const outcome = await runTurn(capped.sessionId, 'carry on', { db, apiKey: 'never-used', usdInrRate: FX, channel: { kind: 'bridge', endpoint: ENDPOINT, token: cappedToken } });
    check(outcome.kind === 'capped', 'the next turn is refused before any model call', outcome.reason);
    const after = await rpc('tools/list', {}, cappedToken);
    check(after.status === 403, 'and its token stops working at the MCP server');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 10b. Ideas from trends (the start form's button)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n10b. Ideas from trends\n');
  {
    // Inputs: three scored trends and one below the threshold. The assertions are on what
    // proposeIdeas returns and on what it sent the model — not on these rows.
    for (const [term, rel] of [['Smart glasses', 0.88], ['Lift accident', 0.86], ['Pressure cooker recall', 0.71], ['Football transfer', 0.2]]) {
      await q(`insert into trend_signals (source, term, channel_id, relevance, relevance_scored_at) values ('wikipedia', $1, $2, $3, now())`, [term, BLT, rel]);
    }
    const sent = [];
    const ideaClient = {
      messages: {
        parse: async (body) => {
          sent.push(body);
          return {
            usage: { input_tokens: 900, output_tokens: 400 },
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '{}' }],
            parsed_output: {
              ideas: [
                { series: 'inside', trend: 'Smart glasses', topic: 'What is packed inside the arm of camera smart glasses', hook: 'There is a computer hidden in your sunglasses arm.', why: 'Smart glasses are the gadget of the month.' },
                { series: 'evolution', trend: 'Lift accident', topic: 'Why a lift with a snapped cable stops itself', hook: 'Cut the cable and the car stays put.', why: 'A lift story is in the news.' },
                { series: 'not_a_series', trend: 'Pressure cooker recall', topic: 'Something off-channel', hook: 'Should be dropped.', why: 'No such series.' },
              ],
            },
          };
        },
      },
    };
    const { proposeIdeas } = require(`${BUILD}/studio/ideas.js`);
    const { getBible } = require(`${BUILD}/bureau/bible.js`);
    const cb = await getBible(db, BLT);
    const ledgerBeforeIdeas = Number((await q(`select count(*)::int n from cost_ledger where channel_id = $1 and stage = '02-concept'`, [BLT]))[0].n);
    const r = await proposeIdeas({ id: BLT, name: 'Built Like That' }, cb, { relevanceThreshold: 0.65, perShortCapInr: 380 }, { db, apiKey: 'stub', usdInrRate: FX, client: ideaClient });
    check(r.ok && r.ideas.length === 2 && r.ideas.every((i) => i.series !== 'not_a_series'), 'ideas on a series the channel does not run are dropped, never guessed', r.ok ? r.ideas.map((i) => i.series).join() : r.reason);
    const userText = String(sent[0]?.messages?.[0]?.content ?? '');
    check(userText.indexOf('Smart glasses') > -1 && userText.indexOf('Smart glasses') < userText.indexOf('Lift accident') && !userText.includes('Football transfer'), 'the model was given the trends most relevant first, and nothing below the threshold');
    const first = r.ok ? r.ideas[0] : null;
    check(first?.relevance === 0.88 && first.videoType === 'engineered' && /- video_type: engineered/.test(first.prompt) && /- series: inside/.test(first.prompt) && /- topic: What is packed inside the arm/.test(first.prompt) && /₹380 per-Short cap/.test(first.prompt) && /Do not approve anything/.test(first.prompt),
      'each idea carries a first message that calls draft_brief with its own fields and the channel’s cap', first?.prompt.split('\n').slice(0, 5).join(' | '));
    const ledgerAfterIdeas = Number((await q(`select count(*)::int n from cost_ledger where channel_id = $1 and stage = '02-concept'`, [BLT]))[0].n);
    check(ledgerAfterIdeas === ledgerBeforeIdeas + 2, 'the one call is ledgered against the channel (input + output rows, rule 5)', `${ledgerAfterIdeas - ledgerBeforeIdeas} rows`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOAD-BEARING for §4: after every tool — drafting, approving, following, re-rolling —
  // the legacy lane's artifacts do not exist beyond what this harness seeded itself.
  // ═══════════════════════════════════════════════════════════════════════════
  {
    const [n] = await q(`select (select count(*)::int from scripts) as scripts, (select count(*)::int from generations) as generations, (select count(*)::int from studio_sessions where script_id is not null) as materialised`);
    check(n.scripts === 1 && n.generations === 0 && n.materialised === 0, 'no session materialised a script and no legacy generation exists (the one script is the harness’s seed)', JSON.stringify(n));
    const ledgerAfter = Number((await q('select count(*)::int n from cost_ledger'))[0].n);
    const nonLlm = await q(`select driver, stage from cost_ledger where driver <> 'anthropic' and driver <> 'gemini'`);
    check(ledgerAfter > ledgerBefore && nonLlm.length === 0, 'the only money the Studio moved was model tokens — no vendor generation', `${ledgerAfter - ledgerBefore} rows`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 11. A real conversational turn (optional, no drafting)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n11. A real session\n');
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.log('  SKIP  no ANTHROPIC_API_KEY. With one, one Opus turn reads channel_overview over the bridge and the');
    console.log('        harness checks the transcript and the ledger rows. It does not draft (that spends a writer call).\n');
  } else {
    const live = await startSession(db, { title: 'verify-studio live', channelId: BLT, spendCapInr: 50 });
    const outcome = await runTurn(live.sessionId, 'Read the channel overview and tell me in two sentences what this channel makes and its per-Short cap. Do not draft anything.', {
      db,
      apiKey,
      usdInrRate: FX,
      channel: { kind: 'bridge', endpoint: ENDPOINT, token: mintSessionToken(live.sessionId, SECRET) },
    });
    check(outcome.kind === 'replied', 'the model completed a turn', outcome.kind === 'replied' ? `₹${outcome.costInr.toFixed(2)}` : JSON.stringify(outcome).slice(0, 200));
    if (outcome.kind === 'replied') {
      console.log(`\n        ${outcome.text.split('\n').join('\n        ')}\n`);
      check(outcome.toolCalls.some((t) => t.name === 'channel_overview'), 'it called channel_overview', outcome.toolCalls.map((t) => t.name).join());
      const read = await readSession(db, live.sessionId);
      check(read.ok && read.detail.summary.ledgerRows >= 2 && read.detail.briefs.length === 0, 'the turn landed in the ledger and drafted nothing', read.ok ? `${read.detail.summary.ledgerRows} rows` : read.detail);
    }
  }
} catch (err) {
  bad('the harness ran to the end', err.stack ?? String(err));
}

await new Promise((resolve) => server.close(resolve));
await scratch.release();
console.log(failures === 0 ? '\nStudio lane checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
