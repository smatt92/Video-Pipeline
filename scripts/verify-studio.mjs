#!/usr/bin/env node
/**
 * Exercise the Studio lane for real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROVES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   The MCP server answers the protocol over a real HTTP socket: initialize, tools/list,
 *   tools/call, notifications, batches, unknown methods — driven by real requests against
 *   the same `serveMcp` the Next route calls.
 *
 *   Its authentication holds: no token, a forged signature, a token minted for another
 *   session, and a session that has stopped are four distinct refusals and none of them
 *   reaches a tool.
 *
 *   All six tools run against a real database. `generate_shot` REFUSES on a fresh install
 *   and lists *both* reasons — no verified video integration and an empty prompt library —
 *   as a result rather than an error.
 *
 *   The spend cap stops. A session at its ceiling refuses the next turn before any model
 *   call is made, flips to `capped`, and its token stops working at the MCP server.
 *
 *   `studio_sessions.cost_inr` is derived from the ledger by 0017's trigger rather than
 *   asserted by the loop, so the number the cap is enforced against cannot be wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DOES NOT PROVE  — read this before calling the lane verified
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   That Anthropic can reach `/api/mcp`. `mcp_servers` is a SERVER-SIDE connector:
 *   Anthropic's infrastructure opens the HTTP connection to the MCP server URL, not the
 *   process that called the Messages API. That leg needs a public hostname and is the one
 *   thing a development container cannot supply. Section 7 runs the real model against the
 *   real MCP server over the *bridge* instead — same tools, same server, same rows, this
 *   process dialling — and says so.
 *
 *   Anything about a video vendor. There is no vendor call in this path at all; the
 *   refusal is the outcome under test.
 *
 * Usage: node scripts/verify-studio.mjs <db-url>
 *        ANTHROPIC_API_KEY=... enables section 7, the real session.
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);

// `server-only` throws when required outside the React Server Components graph, and the
// Studio modules carry it deliberately — it is what makes a client import a failed build
// rather than a leaked service key. Seeding the cache neutralises the guard for this
// process without editing the modules under test.
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = {
  id: serverOnly,
  filename: serverOnly,
  loaded: true,
  exports: {},
  paths: [],
  children: [],
};

const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-studio.mjs <db-url>   (or set DATABASE_URL)');
  process.exit(2);
}

const BUILD = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { serveMcp } = require(`${BUILD}/studio/serve.js`);
const { mintSessionToken } = require(`${BUILD}/studio/token.js`);
const { STUDIO_TOOLS } = require(`${BUILD}/studio/tools.js`);
const { PROTOCOL_VERSION } = require(`${BUILD}/studio/mcp.js`);
const { startSession, runTurn } = require(`${BUILD}/studio/session.js`);
const { readSession } = require(`${BUILD}/studio/read.js`);

const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

const SECRET = 'verify-studio-secret-not-a-real-one';

let failures = 0;
const ok = (l, d = '') => console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
const bad = (l, d = '') => {
  console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
  failures++;
};

// ── A scratch database, created and dropped per run ─────────────────────────
//
// Shared with every other harness — see scripts/lib/scratch.mjs for why absence assertions
// need one.
const scratch = await scratchDatabase(dbUrl, 'studio');
const client = scratch.client;
const db = supabaseShim(client);

// ── A real HTTP server over the real handler ────────────────────────────────
//
// Not a function call into serveMcp. Over the wire means the JSON framing, the header
// parsing, the status codes and the bodies are all exercised — everything the connector
// would exercise except which machine opens the socket.
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

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
        { db, secret: SECRET },
      );
      res.writeHead(result.status, {
        'content-type': 'application/json',
        ...(result.headers ?? {}),
      });
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
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
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

// ═══════════════════════════════════════════════════════════════════════════
// 0. A channel, so materialisation has somewhere to hang
// ═══════════════════════════════════════════════════════════════════════════

const { rows: channelRows } = await client.query(
  `insert into channels (name, platform, niche, is_active)
   values ('verify-studio', 'youtube', 'verification', true) returning id`,
);
const channelId = channelRows[0].id;

// ── The workspace's FX rate, which a session now needs to open ──────────────
//
// `startSession` refuses without it: a spend cap in rupees is unenforceable if a rupee
// figure cannot be computed, and that check is deliberately at zero tokens rather than
// after a billed turn. The rate moved out of the environment and into `profiles` — so this
// is a fixture that has to seed a row rather than a variable it can set.
//
// A literal, not an environment write. The harness is testing the cap arithmetic, not where
// the rate comes from, so it fixes the input where the test can see it — and a
// `process.env.X ??=` here would be the scaffolding-restores-a-deleted-default failure that
// this exact change was made to expose.
await client.query(
  `insert into profiles (id, email, usd_inr_rate)
   values (gen_random_uuid(), 'studio-harness@invalid.test', 88.5)
   on conflict (email) do update set usd_inr_rate = excluded.usd_inr_rate`,
);

// ═══════════════════════════════════════════════════════════════════════════
// 1. Opening a session
// ═══════════════════════════════════════════════════════════════════════════

console.log('1. Opening a session\n');

const capless = await startSession(db, { title: 'no cap', spendCapInr: 0 });
if (capless.ok) bad('a session without a cap is refused', 'it opened');
else ok('a session without a cap is refused', capless.code);

const started = await startSession(db, {
  title: 'verify-studio',
  channelId,
  spendCapInr: 500,
});

if (!started.ok) {
  bad('a session opens', started.detail);
  await shutdown();
}
const sessionId = started.sessionId;
ok('a session opens', sessionId.slice(0, 8));

const token = mintSessionToken(sessionId, SECRET);

// ═══════════════════════════════════════════════════════════════════════════
// 2. The protocol, over the socket
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n2. The MCP protocol over real HTTP\n');

{
  const { status, body, headers } = await rpc('initialize', { protocolVersion: PROTOCOL_VERSION }, token);
  if (status === 200 && body?.result?.serverInfo?.name === 'kiln-studio') {
    ok('initialize', `protocolVersion=${body.result.protocolVersion}`);
  } else {
    bad('initialize', `status ${status} ${JSON.stringify(body)}`);
  }
  if (headers.get('mcp-protocol-version') === PROTOCOL_VERSION) ok('protocol version header');
  else bad('protocol version header', headers.get('mcp-protocol-version'));

  if (body?.result?.capabilities?.tools && !body.result.capabilities.resources) {
    ok('advertises tools only', 'the connector calls tools/list and tools/call and nothing else');
  } else {
    bad('advertises tools only', JSON.stringify(body?.result?.capabilities));
  }
}

{
  const { body } = await rpc('tools/list', {}, token);
  const names = (body?.result?.tools ?? []).map((t) => t.name).sort();
  const expected = STUDIO_TOOLS.map((t) => t.name).sort();
  if (JSON.stringify(names) === JSON.stringify(expected)) ok('tools/list', names.join(', '));
  else bad('tools/list', `${names.join(', ')} ≠ ${expected.join(', ')}`);

  const schemas = (body?.result?.tools ?? []).filter((t) => t.inputSchema?.type === 'object');
  if (schemas.length === expected.length) ok('every tool carries a JSON Schema');
  else bad('every tool carries a JSON Schema', `${schemas.length} of ${expected.length}`);
}

{
  // A notification has no id and must get no response at all. Answering one is a protocol
  // violation, and a client that is waiting for nothing hangs on whatever it gets.
  const { status, body } = await rpc('notifications/initialized', {}, token, null);
  if (status === 202 && body === null) ok('a notification gets no response', '202, empty body');
  else bad('a notification gets no response', `status ${status}, body ${JSON.stringify(body)}`);
}

{
  const { body } = await rpc('tools/kill_everything', {}, token);
  if (body?.error?.code === -32601) ok('an unknown method is a JSON-RPC error', body.error.message);
  else bad('an unknown method is a JSON-RPC error', JSON.stringify(body));
}

{
  const { body } = await rpc('tools/call', { name: 'not_a_tool', arguments: {} }, token);
  if (body?.error?.code === -32602) ok('an unknown tool is a JSON-RPC error', body.error.message);
  else bad('an unknown tool is a JSON-RPC error', JSON.stringify(body));
}

{
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
    ]),
  });
  const batch = await res.json();
  if (Array.isArray(batch) && batch.length === 2) {
    ok('a batch drops the notification', '3 in, 2 out');
  } else {
    bad('a batch drops the notification', JSON.stringify(batch));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Authentication
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n3. Authentication\n');

{
  const { status } = await rpc('tools/list', {}, null);
  if (status === 401) ok('no token is refused');
  else bad('no token is refused', `status ${status}`);
}

{
  const forged = mintSessionToken(sessionId, 'a different secret entirely');
  const { status } = await rpc('tools/list', {}, forged);
  if (status === 401) ok('a forged signature is refused');
  else bad('a forged signature is refused', `status ${status}`);
}

{
  // Correctly signed, for a session that does not exist. The session id is carried by the
  // token rather than by an argument precisely so a model cannot name someone else's.
  const stranger = mintSessionToken(randomUUID(), SECRET);
  const { status } = await rpc('tools/list', {}, stranger);
  if (status === 401) ok('a valid signature over an unknown session is refused');
  else bad('a valid signature over an unknown session is refused', `status ${status}`);
}

{
  const other = await startSession(db, { title: 'other', channelId, spendCapInr: 10 });
  await client.query(`update studio_sessions set status = 'archived', stopped_reason = 'archived by the operator' where id = $1`, [other.sessionId]);
  const { status, body } = await rpc('tools/list', {}, mintSessionToken(other.sessionId, SECRET));
  if (status === 403 && body?.error === 'session_not_active') {
    ok('a stopped session refuses its own token', body.detail);
  } else {
    bad('a stopped session refuses its own token', `status ${status} ${JSON.stringify(body)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. The tools, on a fresh install
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n4. The six tools against a real database\n');

{
  const result = await callTool('list_prompt_recipes', {}, token);
  if (result?.ok && result.count === 0 && typeof result.note === 'string') {
    ok('list_prompt_recipes on an empty library', 'returns a reason, not just a zero');
  } else {
    bad('list_prompt_recipes on an empty library', JSON.stringify(result));
  }

  // Skeletons come back only when there is nothing to list — the one moment an author needs
  // a starting shape. This is also what reads `prompts/skeletons.ts`: a shape catalogue with
  // no caller is a view with no reader wearing different clothes, and harder to notice,
  // because its existence reads as coverage.
  const skeletons = result?.skeletons;
  if (Array.isArray(skeletons) && skeletons.length > 0 && skeletons[0].slots?.length > 0) {
    ok('  · with a starting shape to author against', skeletons.map((s) => s.key).join(', '));
  } else {
    bad('  · with a starting shape to author against', JSON.stringify(skeletons));
  }

  // ── LOAD-BEARING ─────────────────────────────────────────────────────────
  //
  // A skeleton must never be mistakable for a recipe. It has no params, no sample output,
  // and has never run against our driver; the route to the library still runs through a
  // watched clip. `unverified` saying so on every one is what keeps a shape catalogue from
  // becoming an import path — which is the failure the library exists to prevent, and the
  // one thing that would make adding these a mistake rather than an aid.
  if (skeletons?.every?.((s) => typeof s.unverified === 'string' && s.unverified.length > 20)) {
    ok('  · every one saying what is unproven about it', 'a shape, not a recipe');
  } else {
    bad('  · every one saying what is unproven about it', JSON.stringify(skeletons));
  }
  if (skeletons?.every?.((s) => s.params === undefined)) {
    ok('  · and carrying no params for anyone to transplant');
  } else {
    bad('  · and carrying no params for anyone to transplant');
  }
}

{
  const result = await callTool('list_session_shots', {}, token);
  if (result?.ok && result.script_id === null && result.count === 0) {
    ok('list_session_shots before materialisation', 'null script, not an error');
  } else {
    bad('list_session_shots before materialisation', JSON.stringify(result));
  }
}

{
  const result = await callTool('stitch_rough_cut', {}, token);
  if (result?.refused && result.blockers?.[0]?.code === 'no_script') {
    ok('stitch_rough_cut with nothing to stitch refuses', result.blockers[0].code);
  } else {
    bad('stitch_rough_cut with nothing to stitch refuses', JSON.stringify(result));
  }
}

// ── The refusal the whole lane is expected to produce on a fresh install ────
{
  const result = await callTool(
    'generate_shot',
    { description: 'a wide shot of a city at dusk', duration_s: 4 },
    token,
  );

  if (!result?.refused) {
    bad('generate_shot refuses on an untouched workspace', JSON.stringify(result).slice(0, 200));
  } else {
    const codes = result.blockers.map((b) => b.code);
    ok('generate_shot refuses on an untouched workspace', result.summary);

    // Both reasons, in one turn. Refusing on credentials and then, one paid turn later, on
    // the empty library is half an answer for the price of a whole one.
    if (codes.includes('video_integration_unusable') || codes.includes('video_integration_deferred')) {
      ok('  · names the unverified video integration');
    } else {
      bad('  · names the unverified video integration', codes.join(', '));
    }

    if (codes.includes('empty_prompt_library')) ok('  · and the empty prompt library');
    else bad('  · and the empty prompt library', codes.join(', '));

    for (const blocker of result.blockers) {
      if (!blocker.remedy || blocker.remedy.length < 10) {
        bad('  · every blocker carries a remedy', blocker.code);
      }
    }
    ok('  · every blocker carries a remedy');
  }
}

{
  const result = await callTool(
    'save_prompt_recipe',
    {
      name: 'broken recipe',
      driver: 'someone',
      model: 'some-model',
      template: 'a {{subject}} in a {{place}}',
      params: '{"motion":"push_in"}',
      tags: ['establishing'],
    },
    token,
  );

  // The interesting refusal: `{{subject}}` is not fillable from what a shot carries, so
  // the recipe would reach the vendor verbatim and be billed as a clip of the literal
  // words. A schema cannot express that; the library's own validator can.
  if (result?.refused && /subject|place|placeholder/i.test(JSON.stringify(result.blockers))) {
    ok('save_prompt_recipe refuses an unfillable template', result.blockers[0].detail.slice(0, 90));
  } else {
    bad('save_prompt_recipe refuses an unfillable template', JSON.stringify(result));
  }
}

{
  const result = await callTool(
    'save_prompt_recipe',
    {
      name: 'verify establishing',
      driver: 'someone',
      model: 'some-model',
      template: 'establishing shot: {{description}}, {{duration}}s',
      params: '{"motion":"push_in","aspect":"9:16"}',
      tags: ['establishing'],
    },
    token,
  );
  if (result?.ok && result.version === 1) ok('save_prompt_recipe accepts a fillable one', result.name);
  else bad('save_prompt_recipe accepts a fillable one', JSON.stringify(result));
}

{
  const result = await callTool('check_generation', { generation_id: randomUUID() }, token);
  if (result?.refused && result.blockers?.[0]?.code === 'unknown_generation') {
    ok('check_generation on an unknown id refuses');
  } else {
    bad('check_generation on an unknown id refuses', JSON.stringify(result));
  }
}

// ── The same call once a recipe exists: a different, narrower refusal ───────
//
// The library is no longer empty, so that blocker is gone and the pricing one is exposed.
// The recipe was saved under a driver with no rate card row, and rule 5 says a call that
// cannot be priced does not happen — so the refusal changes shape rather than disappearing.
{
  const result = await callTool(
    'generate_shot',
    { description: 'a wide shot of a city at dusk', duration_s: 4 },
    token,
  );

  if (!result?.refused) {
    bad('generate_shot still refuses with a recipe but no rate', JSON.stringify(result).slice(0, 200));
  } else {
    const codes = result.blockers.map((b) => b.code);
    ok('generate_shot still refuses with a recipe but no rate', codes.join(', '));

    if (!codes.includes('empty_prompt_library')) ok('  · the library blocker is gone');
    else bad('  · the library blocker is gone', 'still reported after a recipe was saved');

    if (codes.includes('unpriced')) ok('  · and an unpriced call is refused', 'rule 5');
    else bad('  · and an unpriced call is refused', codes.join(', '));
  }
}

{
  // Rows, not exceptions: the refusals above must not have written a script or a shot.
  const { rows } = await client.query(
    `select (select count(*) from scripts) as scripts, (select count(*) from shots) as shots`,
  );
  if (Number(rows[0].scripts) === 0 && Number(rows[0].shots) === 0) {
    ok('a refused generation writes nothing', 'no script, no shot');
  } else {
    bad('a refused generation writes nothing', JSON.stringify(rows[0]));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. The ledger derives the session total
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n5. Spend is derived from the ledger, not asserted by the loop\n');

{
  await client.query(
    `insert into cost_ledger (driver, stage, entry_kind, studio_session_id, unit, quantity, cost_usd, cost_inr, usd_inr_rate, idempotency_key)
     values ('anthropic','studio','reconcile',$1,'input_token',1200,0.006,0.531,88.5,$2),
            ('anthropic','studio','reconcile',$1,'output_token',400,0.010,0.885,88.5,$3)`,
    [sessionId, `verify:${sessionId}:input_token`, `verify:${sessionId}:output_token`],
  );

  const { rows } = await client.query(
    `select cost_inr, input_tokens, output_tokens from studio_sessions where id = $1`,
    [sessionId],
  );

  const total = Number(rows[0].cost_inr);
  if (Math.abs(total - 1.416) < 0.001) ok('cost_inr is the sum of the ledger rows', `₹${total}`);
  else bad('cost_inr is the sum of the ledger rows', `₹${total} ≠ ₹1.416`);

  if (Number(rows[0].input_tokens) === 1200 && Number(rows[0].output_tokens) === 400) {
    ok('token counts come from the ledger too', '1200 in / 400 out');
  } else {
    bad('token counts come from the ledger too', JSON.stringify(rows[0]));
  }
}

{
  // The property that makes the cap a control: the session row cannot disagree with the
  // ledger, because it is not written independently of it.
  await client.query(`update studio_sessions set cost_inr = 0 where id = $1`, [sessionId]);
  await client.query(
    `insert into cost_ledger (driver, stage, entry_kind, studio_session_id, unit, quantity, cost_usd, cost_inr, usd_inr_rate, idempotency_key)
     values ('anthropic','studio','reconcile',$1,'input_token',1,0.000005,0.00044,88.5,$2)`,
    [sessionId, `verify:${sessionId}:tamper`],
  );

  const { rows } = await client.query(`select cost_inr from studio_sessions where id = $1`, [sessionId]);
  if (Math.abs(Number(rows[0].cost_inr) - 1.41644) < 0.0001) {
    ok('a hand-edited total is corrected by the next ledger row', `₹${rows[0].cost_inr}`);
  } else {
    bad('a hand-edited total is corrected by the next ledger row', `₹${rows[0].cost_inr}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. The cap stops rather than warns
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n6. The spend cap stops the session\n');

{
  const capped = await startSession(db, { title: 'at the ceiling', channelId, spendCapInr: 1 });
  const cappedToken = mintSessionToken(capped.sessionId, SECRET);

  // Working tools before the cap is reached, so the refusal afterwards is attributable to
  // the cap rather than to the session never having worked.
  const before = await callTool('list_prompt_recipes', {}, cappedToken);
  if (before?.ok) ok('tools work before the cap');
  else bad('tools work before the cap', JSON.stringify(before));

  await client.query(
    `insert into cost_ledger (driver, stage, entry_kind, studio_session_id, unit, quantity, cost_usd, cost_inr, usd_inr_rate, idempotency_key)
     values ('anthropic','studio','reconcile',$1,'output_token',5000,0.125,2.50,88.5,$2)`,
    [capped.sessionId, `verify:${capped.sessionId}:over`],
  );

  // No API key needed and none used: the cap is checked before the model call, so a
  // session already at its ceiling cannot buy one more turn to discover it.
  const outcome = await runTurn(capped.sessionId, 'carry on', {
    db,
    apiKey: 'this-key-is-never-used-because-the-cap-fires-first',
    usdInrRate: 88.5,
    channel: { kind: 'bridge', endpoint: ENDPOINT, token: cappedToken },
  });

  if (outcome.kind === 'capped') ok('the next turn is refused before any model call', outcome.reason);
  else bad('the next turn is refused before any model call', JSON.stringify(outcome));

  const { rows } = await client.query(
    `select status, stopped_reason, stopped_at from studio_sessions where id = $1`,
    [capped.sessionId],
  );
  if (rows[0].status === 'capped') ok('the session is capped, in a row');
  else bad('the session is capped, in a row', rows[0].status);

  if (rows[0].stopped_reason && rows[0].stopped_at) {
    ok('and it says why', rows[0].stopped_reason);
  } else {
    bad('and it says why', 'status changed with no reason');
  }

  const after = await rpc('tools/list', {}, cappedToken);
  if (after.status === 403) ok('its token stops working at the MCP server', after.body.detail);
  else bad('its token stops working at the MCP server', `status ${after.status}`);

  // Stopping is not rolling back. The evidence and the money both survive.
  const { rows: kept } = await client.query(
    `select count(*)::int as rows from cost_ledger where studio_session_id = $1`,
    [capped.sessionId],
  );
  if (kept[0].rows === 1) ok('the cost rows survive the stop', 'nothing is rolled back');
  else bad('the cost rows survive the stop', `${kept[0].rows} rows`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. A real session — real model, real MCP server, real rows
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n7. A real session\n');

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

if (!apiKey) {
  console.log('  SKIP  no ANTHROPIC_API_KEY in the environment.');
  console.log('        This is the one section that spends money and the one that proves the');
  console.log('        lane end to end: a real Opus 5 turn, calling this MCP server over real');
  console.log('        HTTP, surfacing generate_shot’s refusal as a refusal, and leaving a');
  console.log('        transcript and a cost row behind. Re-run with a key to execute it.\n');
} else {
  const live = await startSession(db, {
    title: 'verify-studio live',
    channelId,
    spendCapInr: 50,
  });

  if (!live.ok) {
    bad('a live session opens', live.detail);
  } else {
    const liveToken = mintSessionToken(live.sessionId, SECRET);

    const outcome = await runTurn(
      live.sessionId,
      'I want a 20-second short about why cities get hotter than the countryside. ' +
        'Check what recipes exist, then try to generate the opening shot. Tell me plainly ' +
        'what you can and cannot do right now.',
      {
        db,
        apiKey,
        usdInrRate: 88.5,
        channel: { kind: 'bridge', endpoint: ENDPOINT, token: liveToken },
      },
    );

    if (outcome.kind === 'replied') {
      ok('the model completed a turn', `₹${outcome.costInr.toFixed(2)}`);
      console.log('\n        ── what it said ──\n');
      console.log(
        outcome.text
          .split('\n')
          .map((l) => `        ${l}`)
          .join('\n'),
      );
      console.log('');

      const called = outcome.toolCalls.map((t) => `${t.name}${t.refused ? ' (refused)' : ''}`);
      if (outcome.toolCalls.length > 0) ok('it called the tools', called.join(', '));
      else bad('it called the tools', 'no tool calls');

      const refusedGenerate = outcome.toolCalls.find((t) => t.name === 'generate_shot' && t.refused);
      if (refusedGenerate) {
        ok('generate_shot refused, and the session surfaced it as a refusal', refusedGenerate.summary);
      } else if (outcome.toolCalls.some((t) => t.name === 'generate_shot')) {
        bad('generate_shot refused', 'it was called and did not refuse');
      } else {
        console.log('  NOTE  the model did not reach generate_shot this turn.');
      }
    } else {
      bad('the model completed a turn', JSON.stringify(outcome).slice(0, 300));
    }

    const read = await readSession(db, live.sessionId);
    if (read.ok) {
      const d = read.detail;
      if (d.transcript.length >= 2) ok('the transcript is stored', `${d.transcript.length} entries`);
      else bad('the transcript is stored', `${d.transcript.length} entries`);

      if (d.summary.ledgerRows >= 2) ok('the cost rows landed', `${d.summary.ledgerRows} rows, ₹${d.summary.costInr.toFixed(2)}`);
      else bad('the cost rows landed', `${d.summary.ledgerRows} rows`);

      // Printed, not just counted. This section exists to prove money and rows move
      // together, and the run that found the ON CONFLICT defect reported "0 rows" — a
      // count told you something was wrong and could not tell you what. The rows
      // themselves reconcile against the rate card, which a total cannot.
      const { rows: ledger } = await client.query(
        `select unit, quantity, cost_usd, cost_inr, entry_kind, idempotency_key
           from cost_ledger where studio_session_id = $1 order by unit`,
        [live.sessionId],
      );
      console.log('\n        ── the ledger rows ──\n');
      for (const l of ledger) {
        console.log(
          `        ${l.unit.padEnd(13)} ${String(l.quantity).padStart(6)}  ` +
            `$${Number(l.cost_usd).toFixed(6)}  ₹${Number(l.cost_inr).toFixed(5)}  ` +
            `${l.entry_kind}  ${l.idempotency_key}`,
        );
      }
      console.log('');

      if (d.summary.inputTokens > 0 && d.summary.outputTokens > 0) {
        ok('token counts are real', `${d.summary.inputTokens} in / ${d.summary.outputTokens} out`);
      } else {
        bad('token counts are real', JSON.stringify(d.summary));
      }

      // Expected on a fresh install: the session had nothing it could generate, so it must
      // NOT have materialised a script. A script here would mean the lane wrote a video
      // nobody decided to make.
      if (d.script === null) {
        ok('no script was materialised', 'nothing was generated, so nothing was decided');
      } else {
        console.log(`  NOTE  a script was materialised: ${d.script.id} (drafted_by=${d.script.draftedBy})`);
      }
    } else {
      bad('the session reads back', read.detail);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════

console.log('\n8. What this run did not prove\n');
console.log('  The Messages API mcp_servers connector opens the HTTP connection to');
console.log('  /api/mcp from Anthropic’s infrastructure, not from this process. Section 7');
console.log('  drove the same server over the same protocol from here instead. Everything');
console.log('  on this side of that socket is exercised; the socket itself needs a public');
console.log('  hostname. See docs/decisions/0008-what-is-unverified.md §7.\n');

await shutdown();

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await scratch.release();
  console.log(failures === 0 ? 'Studio lane checks passed.\n' : `${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}
