#!/usr/bin/env node
/**
 * verify:characters — the "Cartoon characters" video type (decision 0024), against a STUB image
 * vendor and a stub rewrite model. Nothing here can spend.
 *
 *   §1 Zero locked sheets: Approvals offers the type disabled with the reason, and the planner
 *      plans a 'characters' episode as illustrated, recording why. The accepting half of that
 *      refusal: the fallen-back episode's pictures carry NO reference and the no-people clause.
 *   §2 A sheet is generated (approver only, logged, the worker started with a request id), its
 *      ledger estimate exists BEFORE the vendor is called, it is stored, and it is NOT locked.
 *      A replay of the same request pays nothing. Director Ohm's sheet is the lamp — no body.
 *   §3 Lock: an agent is refused, another character's sheet is refused; Sahil's lock writes the
 *      storage key into channel_characters.reference_frame (the frame:lock field), logs it,
 *      and re-syncs the cast.
 *   §4 LOAD-BEARING — the accepting branch: a 'characters' episode whose cast is Pip, Marlo,
 *      Mrs. Iyer and Director Ohm, with sheets locked for Pip, Marlo and Ohm. Every submitted
 *      still carries exactly the locked sheet URIs and tags of the characters in that picture
 *      — read from the rows the lock wrote, not from the code that chose them — Iyer is left
 *      out and recorded, and Ohm is drawn only as his object.
 *   §5 The checks around it: a rewrite naming an unreferenced cast member is refused; more
 *      than three wanted characters keeps three; a run that cannot read sheets draws nobody;
 *      Approvals prices the type exactly as illustrated once a sheet is locked.
 *
 * Seeds inputs (the folder bible imported as rows, a verified integration, the FX rate, a brief
 * and its script); asserts what the code under test wrote and what the stub vendor received.
 *
 * Usage: node scripts/verify-characters.mjs <db-url>
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const serverOnly = require.resolve('server-only');
require.cache[serverOnly] = { id: serverOnly, filename: serverOnly, loaded: true, exports: {}, paths: [], children: [] };
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('usage: node scripts/verify-characters.mjs <db-url>');
  process.exit(2);
}
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { BUREAU_CHANNEL_ID: CH } = require(`${B}/fixtures/seed-channel.js`);
const { mintBureauToken } = require(`${B}/bureau/tokens.js`);
const { importFolderBible } = require(`${B}/channels/bible-admin.js`);
const { getBible } = require(`${B}/bureau/bible.js`);
const P = require(`${B}/bureau/episode-steps.js`);
const S = require(`${B}/bureau/character-sheets.js`);
const PC = require(`${B}/bureau/picture-cast.js`);
const { stillPromptFor, generateStillForShot } = require(`${B}/bureau/stills.js`);
const { formatOptions } = require(`${B}/bureau/format-estimates.js`);
const { parseScript } = require(`${B}/bureau/script-lines.js`);
const { supabaseShim } = await import('./lib/supabase-shim.mjs');
const { scratchDatabase } = await import('./lib/scratch.mjs');

let failures = 0;
const check = (c, l, d = '') => {
  if (c) console.log(`  PASS  ${l}${d ? ` — ${d}` : ''}`);
  else {
    console.error(`  FAIL  ${l}${d ? ` — ${d}` : ''}`);
    failures++;
  }
};
const scratch = await scratchDatabase(dbUrl, 'characters');
const client = scratch.client;
const db = supabaseShim(client);
const q = async (sql, p = []) => (await client.query(sql, p)).rows;
const thrown = async (p) => p.then(() => null, (err) => err.message);

// A PNG header is all `sniff` needs; the bytes are never decoded.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const stored = new Map();
const putBytes = async (key, body) => {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  const buf = Buffer.concat(chunks);
  stored.set(key, buf);
  return buf.length;
};
// The bucket's presign, stubbed: the harness can recompute it from a key without asking the code.
const BUCKET = 'https://bucket.test/';
const resolveRef = async (ref) => {
  if (!ref.startsWith('storage:')) throw new Error(`not ours: ${ref}`);
  return `${BUCKET}${ref.slice('storage:'.length)}`;
};

/** The image vendor: records each request and, at submit, how many estimate rows existed for it. */
function vendor() {
  const calls = [];
  return {
    calls,
    submit: async (i) => {
      const est = Number((await q(`select count(*)::int n from cost_ledger cl join generations g on g.id = cl.generation_id where g.status = 'submitting' and cl.entry_kind = 'estimate'`))[0].n);
      calls.push({ ...i, estimatesAtSubmit: est });
      return { ok: true, taskId: `task_${calls.length}` };
    },
    wait: async () => ({ state: 'succeeded', outputUrl: 'https://vendor.test/out.png', charged: { quantity: 5, unit: 'credit', usd: 0.05 } }),
    fetchBytes: async () => PNG,
  };
}

/** The rewrite model: writes a scene that uses exactly the tags the message lists (or none). */
const llmCalls = [];
const llmClient = {
  messages: {
    parse: async (body) => {
      const user = String(body.messages[0].content);
      llmCalls.push({ system: String(body.system ?? ''), user });
      const tags = [...user.matchAll(/^- @([A-Za-z0-9_]+)/gm)].map((m) => `@${m[1]}`);
      const scene = tags.length ? `${tags.join(' and ')} beside a large glowing Moon over a calm ocean, an office desk in front` : 'a large glowing Moon over a calm ocean, an office desk in front';
      return { usage: { input_tokens: 400, output_tokens: 40 }, stop_reason: 'end_turn', parsed_output: { scene } };
    },
  },
};

console.log('\nCartoon characters — sheets, the lock, and the cast in the pictures\n');
try {
  // ── The world: inputs ─────────────────────────────────────────────────────
  const [prof] = await q(`insert into profiles (id, email, usd_inr_rate) values (gen_random_uuid(), 'sahil@invalid.test', 88) returning id`);
  await q(`insert into integrations (slug, kind, is_enabled, last_verified_at) values ('runway', 'video', true, now()) on conflict (slug) do update set is_enabled = true, last_verified_at = now()`);
  await q('update channel_policy set stills_enabled = true where channel_id = $1', [CH]);
  await importFolderBible(db, { channelId: CH, slug: 'bureau-of-reality', by: 'verify:characters' });
  const minted = await mintBureauToken(db, { name: 'Sahil', scope: 'approver', channelId: CH, profileId: prof.id });
  const mintedAgent = await mintBureauToken(db, { name: 'Routine', scope: 'agent', channelId: CH, profileId: null });
  const approver = { id: minted.id, name: 'Sahil', scope: 'approver', channelId: CH, profileId: prof.id };
  const agent = { id: mintedAgent.id, name: 'Routine', scope: 'agent', channelId: CH, profileId: null };
  const [{ unit_cost: rateUsd }] = await q(`select unit_cost from rate_card where driver = 'runway' and model = 'gen4_image' and endpoint = '/v1/text_to_image' and unit = 'image_720p' and is_verified order by effective_from desc limit 1`);
  const SHEET_INR = Number(rateUsd) * 88;
  check(Math.abs(SHEET_INR - 4.4) < 1e-9, 'the image rate the sheet is priced on is 0044’s USD 0.05 → ₹4.40 at ₹88', String(rateUsd));

  // Four lines of equal length, four shots of equal length: the planner binds them one to one.
  const SCRIPT = ['Pip: Where did the Moon go?!', 'Marlo: Filed under missing.', 'Mrs. Iyer: The calendar says no.', 'Director Ohm: This will be noted.'].join('\n');
  const cbFolder = await getBible(db, CH);
  const parsed = parseScript(SCRIPT, cbFolder);
  check(parsed.ok && parsed.lines.map((l) => l.speaker).join() === 'pip,marlo,iyer,ohm', 'the script parses to four speakers', parsed.ok ? parsed.lines.map((l) => l.speaker).join() : JSON.stringify(parsed));
  const SHOTS = [
    { beat_id: 'cold_open', route: 'overlay', description: 'Empty sky where the Moon was', duration_s: 4, characters: [] },
    { beat_id: 'stakes', route: 'character_beat', description: 'Marlo files the Moon as missing', duration_s: 4, characters: ['pip'] },
    { beat_id: 'mechanism_1', route: 'overlay', description: 'A desk calendar with a festival date', duration_s: 4, characters: [] },
    { beat_id: 'button', route: 'overlay', description: 'The brass lamp flickers', duration_s: 4, characters: [] },
  ];
  async function episode(label, format) {
    const [b] = await q(
      `insert into briefs (channel_id, slot_id, series, lead_character, desk, premise, premise_type, structure_variant, ending_type, music_bed, hook_archetype, punchlines, beat_sheet, script_text, shot_list, fact, titles, pinned_comment, status, created_by, approved_edits, approved_at, chosen_punchline)
       values ($1, null, 'incident', 'pip', 'gravity', $2, 'x', 'y', 'z', 'bed_chalk_percussion', 'question', '["a","b","c"]', '[]', $3, $4, '{"claim":"The Moon raises tides.","source_url":"https://oceanservice.noaa.gov/x"}', '[{"text":"t1","hook_archetype":"question"},{"text":"t2","hook_archetype":"warning"},{"text":"t3","hook_archetype":"number_claim"}]', 'Which desk next?', 'approved', 'agent', $5, now(), 'a') returning id`,
      [CH, `${label}: Pip misplaces the Moon.`, SCRIPT, JSON.stringify(SHOTS), JSON.stringify({ visual_format: format })],
    );
    const [con] = await q(`insert into concepts (channel_id, title, angle, rubric_version, status) values ($1, $2, 'a', 'v', 'in_production') returning id`, [CH, label]);
    const [scr] = await q(`insert into scripts (concept_id, hook, beats, vo_text, drafted_by, structure_hash) values ($1, 'h', $2, $3, 'x', $4) returning id`, [con.id, JSON.stringify({ lines: parsed.lines }), parsed.voText, `h-${label}`]);
    const [ep] = await q(`insert into episodes (brief_id, channel_id, script_id, status) values ($1, $2, $3, 'queued') returning id`, [b.id, CH, scr.id]);
    return { briefId: b.id, scriptId: scr.id, episodeId: ep.id };
  }
  const stillDeps = (v, extra = {}) => ({ usdInrRate: 88, llmKey: 'test-llm-key', llmClient, apiKey: async () => ({ ok: true, value: 'test-key' }), submit: v.submit, wait: v.wait, fetchBytes: v.fetchBytes, putBytes, resolveRef, ...extra });

  // ═══ 1. Zero locked sheets ═══
  console.log('1. No locked sheet anywhere: offered disabled, planned as illustrated, nobody drawn\n');
  const brief = { series: 'incident', shot_list: SHOTS, script_text: SCRIPT, lead_character: 'pip' };
  const opts0 = await formatOptions(db, CH, brief);
  const ch0 = opts0.options.find((o) => o.format === 'characters');
  const il0 = opts0.options.find((o) => o.format === 'illustrated');
  check(ch0?.disabled === 'no locked character sheets — Library → Characters' && il0?.disabled === null, 'Approvals: Cartoon characters is offered, disabled, with the reason; Illustrated is not disabled', JSON.stringify(ch0));
  check(ch0?.label === 'Cartoon characters' && ch0.inr !== null && ch0.inr === il0?.inr, 'it is still priced, at exactly the illustrated figure', `${ch0?.inr} vs ${il0?.inr}`);
  const e0 = await episode('zero', 'characters');
  await P.planShots(db, e0.episodeId, { usdInrRate: 88, actedBeatAvailable: false });
  const [{ qc: qc0 }] = await q('select qc from episodes where id = $1', [e0.episodeId]);
  check(qc0.plan.format.format === 'illustrated' && qc0.plan.format.requested === 'characters' && qc0.plan.format.fallback_reason === 'no locked character sheets — Library → Characters',
    'LOAD-BEARING (refusal): the planner made it illustrated and recorded that characters was asked for, and why', JSON.stringify(qc0.plan.format));
  const routes0 = (await q('select render_route from shots where script_id = $1 order by idx', [e0.scriptId])).map((r) => r.render_route);
  check(routes0.length === 4 && routes0.every((r) => r === 'still'), 'every shot is still a picture', routes0.join());
  const v0 = vendor();
  const st0 = await P.generateStills(db, e0.episodeId, stillDeps(v0));
  check(st0.made === 4 && v0.calls.length === 4, 'four pictures made', JSON.stringify({ made: st0.made, fellBack: st0.fellBack }));
  check(v0.calls.every((c) => c.references === undefined && /no people, no characters, no faces, no figures, no text/.test(c.prompt) && !/@[A-Z]/.test(c.prompt)),
    'the accepting half of the fallback: no picture carries a reference or a tag, and every one carries the no-people clause', v0.calls[0]?.prompt.slice(0, 120));
  const p0 = (await q(`select g.request_payload->>'prompt_ref' r from generations g join shots s on s.id = g.shot_id where s.script_id = $1`, [e0.scriptId])).map((r) => r.r);
  check(p0.length === 4 && p0.every((r) => r === '21-still.v4'), 'drawn under the no-people prompt (21-still.v4)', p0.join());

  // ═══ 2. Generate a sheet ═══
  console.log('\n2. Generate a sheet: approver only, logged, ledger before the call, not locked\n');
  const started = [];
  const effects = { startSheet: async (i) => { started.push(i); return `run_sheet_${started.length}`; } };
  check(/approver/i.test((await thrown(S.requestCharacterSheet(db, agent, effects, { slug: 'pip' }))) ?? ''), 'an agent token cannot ask for a sheet');
  check(/No character "nobody"/.test((await thrown(S.requestCharacterSheet(db, approver, effects, { slug: 'nobody' }))) ?? ''), 'an unknown character is refused by name');
  check(started.length === 0, 'neither refusal started the worker');
  const req = await S.requestCharacterSheet(db, approver, effects, { slug: 'pip', note: '  longer   lanyard ' });
  check(started.length === 1 && started[0].slug === 'pip' && started[0].note === 'longer lanyard' && started[0].requestId === req.requestId && started[0].channelId === CH, 'the approver’s request starts 27-character-sheet with the request id and the trimmed note', JSON.stringify(started[0]));
  const [logReq] = await q(`select actor_scope, token_id, subject_type, subject_id, exact_text, payload from authorship_log where action = 'character_sheet_request'`);
  check(logReq?.subject_id === 'pip' && logReq.exact_text === 'longer lanyard' && logReq.token_id === approver.id && logReq.payload.request_id === req.requestId, 'authorship_log has the request, verbatim, by the approver', JSON.stringify(logReq));

  const vs = vendor();
  const sheetDeps = { usdInrRate: 88, apiKey: async () => ({ ok: true, value: 'test-key' }), submit: vs.submit, wait: vs.wait, fetchBytes: vs.fetchBytes, putBytes };
  const pip = await S.generateCharacterSheet(db, { channelId: CH, slug: 'pip', note: started[0].note, requestId: req.requestId }, sheetDeps);
  check(pip.ok && !pip.reused, 'Pip’s sheet is made', JSON.stringify(pip));
  check(vs.calls.length === 1 && vs.calls[0].estimatesAtSubmit === 1, 'LOAD-BEARING (rule 5): the sheet’s estimate row existed when the vendor was called', JSON.stringify(vs.calls.map((c) => c.estimatesAtSubmit)));
  check(vs.calls[0].references === undefined, 'a sheet is drawn from the bible text alone — no reference is passed');
  const [pipChar] = await q(`select visual_lock, accent_hex from channel_characters where channel_id = $1 and slug = 'pip'`, [CH]);
  const sp = vs.calls[0].prompt;
  check(sp.includes(pipChar.visual_lock.silhouette) && pipChar.visual_lock.props.every((x) => sp.includes(x)) && sp.includes(pipChar.accent_hex) && sp.includes(pipChar.visual_lock.head_body_ratio) && /full body/.test(sp) && /three-quarter/.test(sp) && sp.includes('Direction: longer lanyard'),
    'the sheet prompt carries the bible’s silhouette, props, ratio and accent (read from the cast row), full body, three-quarter, and the note', sp.slice(0, 200));
  check(sp.length <= 1000, 'within the image prompt limit', String(sp.length));
  // The style is what makes a sheet match the pictures drawn from it. 22-character-sheet.v1 cut
  // it for every on-screen character (each ran over the limit) and nothing here asserted it —
  // the one real sheet was drawn without it. v2 keeps it or refuses.
  const [{ world: dbWorld }] = await q('select world from channel_bibles where channel_id = $1', [CH]);
  check(sp.includes(dbWorld.still_style) && /22-character-sheet\.v3/.test((await q(`select request_payload->>'prompt_ref' r from generations where idempotency_key = $1`, [`sheet:${CH}:pip:${req.requestId}`]))[0].r), 'LOAD-BEARING: Pip’s sheet carries the channel’s still style (the bible’s, read from the row), under 22-character-sheet.v3', String(sp.length));
  const allCast = await q('select slug from channel_characters where channel_id = $1 order by slug', [CH]);
  const allNames = new Map(cbFolder.bible.characters.map((c) => [c.id, c.name]));
  // No name either: the real v1 Pip sheet came back with "Pip" lettered across it.
  const noStyle = allCast.map((r) => [r.slug, S.sheetPromptFor(cbFolder, r.slug, null)]).filter(([slug, r]) => !r.ok || !r.prompt.includes(dbWorld.still_style) || r.prompt.length > 1000 || r.prompt.includes(allNames.get(slug)) || !/no lettering/.test(r.prompt));
  check(allCast.length === 8 && noStyle.length === 0, 'every cast member’s sheet prompt fits the limit WITH the style, never names the character, and says no lettering', JSON.stringify(noStyle.map(([s2, r]) => [s2, r.ok ? r.prompt.length : r.reason])));
  const longNote = S.sheetPromptFor(cbFolder, 'complaint_box', 'x'.repeat(200));
  check(!longNote.ok && /shorten the note/.test(longNote.reason), 'a note that would push the style out is refused, not sent without the style', longNote.ok ? String(longNote.prompt.length) : longNote.reason);

  // ── Figure (07-Oct): the first v2 sheet of Mrs. Iyer was a man — nothing in the prompt said
  // who she is once the name was taken out. The figure is read from the ROW, not the fixture.
  check(typeof pipChar.visual_lock.figure === 'string' && sp.includes(`One original cartoon character: ${pipChar.visual_lock.figure} (`),
    'LOAD-BEARING: Pip’s sheet prompt opens with his figure, read from the cast row the import wrote', sp.slice(0, 120));
  const [iyerChar] = await q(`select visual_lock from channel_characters where channel_id = $1 and slug = 'iyer'`, [CH]);
  const iyerPrompt = S.sheetPromptFor(cbFolder, 'iyer', null);
  check(iyerPrompt.ok && /\bwoman\b/.test(iyerChar.visual_lock.figure) && iyerPrompt.prompt.includes(iyerChar.visual_lock.figure), 'Mrs. Iyer’s sheet prompt says she is a woman', iyerPrompt.ok ? iyerPrompt.prompt.slice(0, 120) : iyerPrompt.reason);
  const noFigure = { bible: { ...cbFolder.bible, characters: cbFolder.bible.characters.map((c) => (c.id === 'iyer' ? { ...c, visual_lock: { ...c.visual_lock, figure: undefined } } : c)) } };
  const refusedFig = S.sheetPromptFor(noFigure, 'iyer', null);
  check(!refusedFig.ok && /has no figure/.test(refusedFig.reason) && /Library → Characters/.test(refusedFig.reason), 'an on-screen character with no figure is refused, naming where to set it — never sent to guess', refusedFig.ok ? 'sent' : refusedFig.reason);
  const ohmFig = S.sheetPromptFor(cbFolder, 'ohm', null);
  check(ohmFig.ok && /An OBJECT, not a person/.test(ohmFig.prompt), 'Director Ohm (object only) needs no figure', ohmFig.ok ? ohmFig.prompt.slice(0, 60) : ohmFig.reason);
  // The Characters screen's Save: drive setCharacterFigure, then read the row and the next prompt.
  const { setCharacterFigure } = require(`${B}/channels/bible-admin.js`);
  const agentSet = await setCharacterFigure(db, { scope: 'agent', profileId: null, via: 'mcp' }, CH, 'kaz', 'a tall woman with a paper lantern for a head');
  check(!agentSet.ok, 'an agent cannot set a figure', JSON.stringify(agentSet));
  const setKaz = await setCharacterFigure(db, { scope: 'approver', profileId: prof.id, via: 'ui:characters' }, CH, 'kaz', '  a tall   woman with a paper lantern for a head ');
  const [kazRow] = await q(`select visual_lock from channel_characters where channel_id = $1 and slug = 'kaz'`, [CH]);
  const kazPrompt = S.sheetPromptFor(await getBible(db, CH), 'kaz', null);
  check(setKaz.ok && kazRow.visual_lock.figure === 'a tall woman with a paper lantern for a head' && kazRow.visual_lock.silhouette && kazPrompt.ok && kazPrompt.prompt.includes('a tall woman with a paper lantern for a head'),
    'Save writes the trimmed figure into the row, keeps the rest of the visual lock, and the next sheet prompt says it', JSON.stringify(kazRow.visual_lock).slice(0, 120));
  const [figLog] = await q(`select subject_id, payload from authorship_log where action = 'character_figure_set'`);
  check(figLog?.subject_id === 'kaz' && figLog.payload.to === 'a tall woman with a paper lantern for a head', 'the change is in authorship_log, from → to', JSON.stringify(figLog?.payload));
  const tooLong = await setCharacterFigure(db, { scope: 'approver', profileId: prof.id, via: 'ui:characters' }, CH, 'kaz', 'x'.repeat(81));
  check(!tooLong.ok && /under 80/.test(tooLong.refused), 'a figure over 80 characters is refused', JSON.stringify(tooLong));
  const [gen] = await q(`select g.shot_id, g.kind, g.status, g.idempotency_key, g.request_payload from generations g where g.request_payload->>'purpose' = 'character_sheet'`);
  check(gen.shot_id === null && gen.kind === 'image' && gen.status === 'succeeded' && gen.idempotency_key === `sheet:${CH}:pip:${req.requestId}` && gen.request_payload.character === 'pip', 'one shot-less image generation, keyed sheet:<channel>:<slug>:<request> (rule 6)', JSON.stringify({ key: gen.idempotency_key, status: gen.status }));
  const ledger = await q(`select entry_kind, cost_source, stage, channel_id, cost_inr, unit from cost_ledger where idempotency_key like $1 order by entry_kind`, [`sheet:${CH}:pip:%`]);
  check(ledger.length === 2 && ledger.every((r) => r.stage === '05-sheet' && r.channel_id === CH) && Math.abs(Number(ledger.find((r) => r.entry_kind === 'estimate').cost_inr) - SHEET_INR) < 1e-9 && ledger.find((r) => r.entry_kind === 'reconcile').cost_source === 'measured',
    'an estimate at ₹4.40 and a measured reconcile, both on the channel, stage 05-sheet', JSON.stringify(ledger.map((r) => [r.entry_kind, r.cost_inr])));
  check(pip.ok && stored.has(pip.storageKey) && /^characters\/pip\/sheet-[0-9a-f]{8}\.png$/.test(pip.storageKey), 'the bytes are in the bucket under characters/pip/', pip.storageKey);
  const [ref0] = await q(`select reference_frame from channel_characters where channel_id = $1 and slug = 'pip'`, [CH]);
  check(JSON.stringify(ref0.reference_frame) === '["PLACEHOLDER_PIP_REF_1"]', 'NOT locked: generating a sheet leaves the bible’s reference frame exactly as it was', JSON.stringify(ref0.reference_frame));
  const again = await S.generateCharacterSheet(db, { channelId: CH, slug: 'pip', note: null, requestId: req.requestId }, { ...sheetDeps, submit: async () => { throw new Error('must not resubmit'); } });
  check(again.ok && again.reused && vs.calls.length === 1, 'a replay of the same request returns the stored sheet and pays nothing', JSON.stringify(again));
  check(/already being drawn/.test((await thrown(S.requestCharacterSheet(db, approver, effects, { slug: 'pip' }))) ?? 'none') === false, 'a finished sheet does not block the next request');

  // Director Ohm: the lamp, never a body.
  const ohmReq = await S.requestCharacterSheet(db, approver, effects, { slug: 'ohm' });
  const ohm = await S.generateCharacterSheet(db, { channelId: CH, slug: 'ohm', note: null, requestId: ohmReq.requestId }, sheetDeps);
  const op = vs.calls.at(-1).prompt;
  check(ohm.ok && /OBJECT, not a person/.test(op) && /no body, no arms, no hands, no face/.test(op) && /lamp/.test(op) && !/full body/.test(op) && !/Character reference sheet/.test(op),
    'Director Ohm’s sheet is the brass lamp: an object, “no body … no face”, and never “full body”', op.slice(0, 220));
  const marloReq = await S.requestCharacterSheet(db, approver, effects, { slug: 'marlo' });
  const marlo = await S.generateCharacterSheet(db, { channelId: CH, slug: 'marlo', note: null, requestId: marloReq.requestId }, sheetDeps);
  check(marlo.ok, 'Marlo’s sheet is made');

  // ═══ 3. Lock ═══
  console.log('\n3. Lock: only the approver, only that character’s sheet; the frame:lock field\n');
  check(/approver/i.test((await thrown(S.lockCharacterSheet(db, agent, { slug: 'pip', generationId: pip.generationId }))) ?? ''), 'an agent token cannot lock');
  check(/not marlo's/i.test((await thrown(S.lockCharacterSheet(db, approver, { slug: 'marlo', generationId: pip.generationId }))) ?? ''), 'Pip’s sheet cannot be locked as Marlo’s');
  const lk = await S.lockCharacterSheet(db, approver, { slug: 'pip', generationId: pip.generationId });
  await S.lockCharacterSheet(db, approver, { slug: 'marlo', generationId: marlo.generationId });
  await S.lockCharacterSheet(db, approver, { slug: 'ohm', generationId: ohm.generationId });
  const locked = Object.fromEntries((await q(`select slug, reference_frame from channel_characters where channel_id = $1 and slug in ('pip','marlo','ohm','iyer')`, [CH])).map((r) => [r.slug, r.reference_frame]));
  check(lk.ok && JSON.stringify(locked.pip) === JSON.stringify([`storage:${pip.storageKey}`]), 'the lock writes storage:<the sheet’s key> into channel_characters.reference_frame — the field pnpm frame:lock writes', JSON.stringify(locked.pip));
  check(JSON.stringify(locked.iyer) === '["PLACEHOLDER_IYER_REF_1"]', 'Mrs. Iyer, never locked, still has only her placeholder');
  const lockLog = await q(`select subject_id, actor_scope, payload from authorship_log where action = 'reference_frame_lock' order by occurred_at`);
  check(lockLog.length === 3 && lockLog[0].subject_id === 'pip' && lockLog[0].payload.generation_id === pip.generationId && JSON.stringify(lockLog[0].payload.from) === '["PLACEHOLDER_PIP_REF_1"]', 'each lock is in authorship_log with what it replaced and which sheet', JSON.stringify(lockLog[0]));
  const [synced] = await q(`select external_ref_id from characters where channel_id = $1 and slug = 'pip'`, [CH]);
  check(synced?.external_ref_id === `storage:${pip.storageKey}`, 'the cast is re-synced: the character row carries the locked reference', synced?.external_ref_id);

  // ═══ 4. The accepting branch ═══
  console.log('\n4. A Cartoon characters episode: each picture carries exactly its characters’ locked sheets\n');
  const e1 = await episode('cast', 'characters');
  await P.planShots(db, e1.episodeId, { usdInrRate: 88, actedBeatAvailable: false });
  const [{ qc: qc1 }] = await q('select qc from episodes where id = $1', [e1.episodeId]);
  check(qc1.plan.format.format === 'characters' && qc1.plan.format.requested === undefined, 'planned in the characters format (sheets exist)', JSON.stringify(qc1.plan.format));
  const v1 = vendor();
  const llmBefore = llmCalls.length;
  const st1 = await P.generateStills(db, e1.episodeId, stillDeps(v1));
  check(st1.made === 4 && v1.calls.length === 4, 'four pictures made', JSON.stringify({ made: st1.made, fellBack: st1.fellBack }));
  // The expectation, from the rows the LOCK wrote and from the script: shot k is spoken by line k.
  const uri = (slug) => `${BUCKET}${locked[slug][0].slice('storage:'.length)}`;
  const expected = [
    [{ uri: uri('pip'), tag: 'Pip' }],
    [{ uri: uri('marlo'), tag: 'Marlo' }, { uri: uri('pip'), tag: 'Pip' }],
    undefined,
    [{ uri: uri('ohm'), tag: 'Ohm' }],
  ];
  for (const [k, want] of expected.entries()) {
    const got = v1.calls[k].references;
    check(JSON.stringify(got) === JSON.stringify(want), `LOAD-BEARING: picture ${k + 1}’s request carries exactly ${want ? want.map((w) => `@${w.tag}`).join(' + ') : 'no reference'} with the locked sheet URIs`, JSON.stringify(got));
  }
  check(v1.calls[0].prompt.startsWith('@Pip ') && /@Pip in front/.test(v1.calls[0].prompt) && v1.calls[0].prompt.includes('cyan scarf line') && v1.calls[0].prompt.includes('#22D3EE') && /no other people or characters besides @Pip/.test(v1.calls[0].prompt),
    'picture 1 names Pip only as @Pip, in front, with his props and accent, and “no other people besides @Pip”', v1.calls[0].prompt.slice(0, 200));
  check(v1.calls[0].prompt.includes(`@Pip in front (${pipChar.visual_lock.figure};`) && v1.calls[1].prompt.includes(iyerChar.visual_lock.figure) === /@Iyer/.test(v1.calls[1].prompt),
    'every picture says who each referenced character is (figure from the row), beside the tag', v1.calls[0].prompt.slice(0, 160));
  check(/@Marlo in front/.test(v1.calls[1].prompt) && /@Pip smaller, beside or behind/.test(v1.calls[1].prompt), 'picture 2: the speaker (Marlo) is foregrounded, Pip (the shot’s character) behind');
  check(!/Iyer/.test(v1.calls[2].prompt) && /no people, no characters, no faces, no figures, no text/.test(v1.calls[2].prompt), 'picture 3: Mrs. Iyer has no sheet, so nobody is drawn and she is not named');
  check(/@Ohm is only the object in its reference image/.test(v1.calls[3].prompt) && /never a body, arms, hands or a face/.test(v1.calls[3].prompt) && !/@Ohm in front/.test(v1.calls[3].prompt), 'picture 4: Director Ohm is only the lamp — never a body');
  const casted = llmCalls.slice(llmBefore);
  check(casted.length === 4 && /CHARACTERS IN THIS PICTURE:\n- @Pip — FOREGROUND/.test(casted[0].user) && /OBJECT ONLY/.test(casted[3].user) && !/CHARACTERS IN THIS PICTURE/.test(casted[2].user), 'the rewrite was told exactly who is in each picture (and Ohm is OBJECT ONLY)');
  const pay1 = await q(`select s.idx, g.request_payload p from generations g join shots s on s.id = g.shot_id where s.script_id = $1 order by s.idx`, [e1.scriptId]);
  check(pay1.map((r) => r.p.prompt_ref).join() === '21-still.v5,21-still.v5,21-still.v4,21-still.v5', 'prompt versions recorded: v5 with the cast, v4 with nobody', pay1.map((r) => r.p.prompt_ref).join());
  check(pay1[2].p.cast.length === 0 && pay1[2].p.cast_excluded.length === 1 && pay1[2].p.cast_excluded[0].slug === 'iyer' && /no locked character sheet/.test(pay1[2].p.cast_excluded[0].reason),
    'Mrs. Iyer’s exclusion is recorded on the generation, with the reason', JSON.stringify(pay1[2].p.cast_excluded));
  const [{ qc: qc1b }] = await q('select qc from episodes where id = $1', [e1.episodeId]);
  check(Array.isArray(qc1b.plan.cast) && qc1b.plan.cast.length === 4 && qc1b.plan.cast[2].excluded[0].slug === 'iyer' && qc1b.plan.cast[1].drawn.join() === 'marlo,pip', 'and on the episode plan, where Cuts reads it', JSON.stringify(qc1b.plan.cast.map((c) => c.drawn)));
  check(v1.calls.every((c) => c.estimatesAtSubmit === 1), 'rule 5 holds for every character picture too', JSON.stringify(v1.calls.map((c) => c.estimatesAtSubmit)));

  // ═══ 5. The checks around it ═══
  console.log('\n5. Refusals and limits around the accepting branch\n');
  const cb = await getBible(db, CH);
  const castNames = cb.bible.characters.map((c) => ({ id: c.id, name: c.name }));
  const pipOnly = PC.pictureCast(cb.bible.characters, ['pip']);
  const naming = { messages: { parse: async () => ({ usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: 'end_turn', parsed_output: { scene: '@Pip hands a calendar to Mrs. Iyer beside the Moon' } }) } };
  const refused = await stillPromptFor({ description: 'd', premise: 'p', cast: castNames, world: cb.bible.world, accent: '#22D3EE', refs: pipOnly.refs }, { db, apiKey: 'k', usdInrRate: 88, client: naming, subject: { kind: 'channel', channelId: CH, idempotencyKey: 'vc:naming', stage: 'test' } });
  check(!refused.ok && /Mrs\. Iyer, who is not referenced/.test(refused.reason), 'a rewrite naming a cast member who is not referenced in the picture is refused (castNamesIn)', refused.ok ? refused.prompt : refused.reason);
  const plain = { messages: { parse: async () => ({ usage: { input_tokens: 10, output_tokens: 10 }, stop_reason: 'end_turn', parsed_output: { scene: 'Pip points at the Moon' } }) } };
  const unrefd = await stillPromptFor({ description: 'd', premise: 'p', cast: castNames, world: cb.bible.world, accent: '#22D3EE', refs: [] }, { db, apiKey: 'k', usdInrRate: 88, client: plain, subject: { kind: 'channel', channelId: CH, idempotencyKey: 'vc:plain', stage: 'test' } });
  check(!unrefd.ok && /names Pip/.test(unrefd.reason), 'with nobody referenced, naming Pip is refused exactly as before');
  const lots = { ...cb.bible, characters: cb.bible.characters.map((c) => (['nib', 'kaz'].includes(c.id) ? { ...c, reference_frame_ids: ['storage:characters/x.png'] } : c)) };
  const four = PC.pictureCast(lots.characters, ['pip', 'marlo', 'nib', 'kaz']);
  check(four.refs.map((r) => r.slug).join() === 'pip,marlo,nib' && four.excluded[0]?.slug === 'kaz' && /at most 3/.test(four.excluded[0].reason), 'four locked characters wanted: three are drawn, the fourth is left out and says why', JSON.stringify(four.excluded));
  const [shot0] = await q('select id, idx, description, script_id from shots where script_id = $1 and idx = 0', [e1.scriptId]);
  const v2 = vendor();
  const noRead = await generateStillForShot(db, { shot: shot0, channelId: CH, premise: 'p', cast: castNames, world: cb.bible.world, accent: '#22D3EE', pictureCast: pipOnly }, stillDeps(v2, { resolveRef: undefined }));
  check(noRead.ok && v2.calls.length === 1 && v2.calls[0].references === undefined && !/@Pip/.test(v2.calls[0].prompt) && noRead.excluded.some((x) => x.slug === 'pip' && /cannot read character sheets/.test(x.reason)),
    'a run that cannot read sheets draws nobody — never Pip without his sheet — and records why', JSON.stringify(noRead.ok ? noRead.excluded : noRead));
  const broken = await generateStillForShot(db, { shot: shot0, channelId: CH, premise: 'p', cast: castNames, world: cb.bible.world, accent: '#22D3EE', pictureCast: pipOnly }, stillDeps(v2, { resolveRef: async () => { throw new Error('bucket down'); } }));
  check(!broken.ok && !broken.spent && /could not be read: bucket down/.test(broken.reason) && v2.calls.length === 1, 'a sheet that cannot be presigned refuses the picture before any money moves', JSON.stringify(broken));
  const opts1 = await formatOptions(db, CH, brief);
  const ch1 = opts1.options.find((o) => o.format === 'characters');
  const il1 = opts1.options.find((o) => o.format === 'illustrated');
  check(ch1.disabled === null && ch1.inr !== null && ch1.inr === il1.inr && /No locked sheet yet for iyer/.test(ch1.note ?? ''), 'with sheets locked, Approvals enables it, prices it as illustrated, and names who will be left out', JSON.stringify(ch1));
  const screen = await S.charactersScreen(db, CH, cb, { usdInrRate: 88 });
  const pipCard = screen.cards.find((c) => c.slug === 'pip');
  check(Math.abs(screen.sheetInr - SHEET_INR) < 1e-9 && screen.canLock && pipCard.locked === `storage:${pip.storageKey}` && pipCard.lockedKey === pip.storageKey && pipCard.sheets.length === 1 && screen.cards.find((c) => c.slug === 'iyer').locked === null,
    'the Characters screen: the one-time sheet price, Pip locked with his sheet, Iyer without', JSON.stringify({ inr: screen.sheetInr, pip: pipCard.locked }));
  check(screen.cards.find((c) => c.slug === 'ohm').objectOnly === true && screen.cards.find((c) => c.slug === 'complaint_box').tag === 'Complaint_Box' && screen.cards.find((c) => c.slug === 'iyer').tag === 'Iyer', 'tags and object-only are what the screen tells Sahil');
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await scratch.release();
}
console.log(failures ? `\n${failures} check(s) failed.\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
