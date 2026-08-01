#!/usr/bin/env node
/**
 * Run stage 3 for real against a Postgres reached directly, rather than through Supabase.
 *
 * The sibling of `verify-script-draft.mjs`, for the case that environment is actually in:
 * `api.anthropic.com` is reachable and `*.supabase.co` is refused at the egress policy, so
 * the vendor leg can be proven and the REST transport cannot. Rather than skip the run
 * entirely, this keeps every part that can be real and swaps only the wire.
 *
 * ── What is the same as production, and what is not ──────────────────────────
 *
 * SAME, by importing the actual functions:
 *   draftScript()   the billed Messages call, its schema validation, its failure taxonomy
 *   structureHash() the anti-template hash
 *   priceFromRates()the ledger arithmetic
 *   llmCostRows()   which subject each row carries, and its idempotency key
 *   scriptRowFor()  the provenance row, field for field
 *
 * NOT the same:
 *   the transport. `runScriptDraft` calls supabase-js, which needs a PostgREST endpoint;
 *   this issues the same rows over a direct connection. So what remains unproven is
 *   precisely `db.from(...).insert(...)` — the thin part — and *everything the database
 *   itself enforces is proven*, because the constraints, keys and generated columns are
 *   the real ones from the real migration sequence.
 *
 * That distinction is the whole reason the three functions above were extracted. A
 * verification path carrying its own copy of the pricing arithmetic would be checking the
 * copy.
 *
 *   ANTHROPIC_API_KEY=... node scripts/verify-script-draft-direct.mjs <postgres-url>
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const BUILD = '../.verify-build/src/lib';

if (!existsSync(new URL(`${BUILD}/script/run.js`, import.meta.url))) {
  console.error('Compile first: npx tsc -p tsconfig.verify.json');
  process.exit(2);
}

const apiKey = process.env.ANTHROPIC_API_KEY;
const dbUrl = process.argv[2] ?? process.env.DATABASE_URL;

if (!apiKey || !dbUrl) {
  console.error('usage: ANTHROPIC_API_KEY=... node scripts/verify-script-draft-direct.mjs <postgres-url>');
  process.exit(2);
}

const { draftScript } = await import(`${BUILD}/script/draft.js`);
const { structureHash } = await import(`${BUILD}/script/structure-hash.js`);
const { scriptRowFor } = await import(`${BUILD}/script/run.js`);
const { priceFromRates, llmCostRows } = await import(`${BUILD}/cost/llm.js`);

// ── Postgres, over psql.
//
// The rest of `scripts/` moved to the `pg` client; this file did not, and the reason is
// narrow. Its value is the recorded stage 3 run — the script, the two cost rows, the
// structure hash — produced by exactly this code against the real Anthropic API. Rewriting
// the transport underneath a harness whose output is the evidence would mean the evidence
// no longer corresponds to any code that ran. It needs psql; nothing else here does.
// `-A -t`: unaligned, tuples only, no CSV quoting. Every query below returns one column,
// so there is no separator to collide with — and CSV would wrap JSON results in quotes it
// then doubles internally, which is a parsing problem invented for no gain.
const sql = (text) =>
  // `-q` matters: without it psql echoes the command tag ("INSERT 0 1") onto stdout after
  // the RETURNING value, and the id gets read back with a newline and a tag stuck to it.
  execFileSync('psql', [dbUrl, '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-c', text], {
    encoding: 'utf8',
  }).trim();

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// ── 1. A concept to draft ────────────────────────────────────────────────────
const channelId = sql(`select id from channels where is_active limit 1`);
if (!channelId) {
  console.error('No active channel — run the seed first.');
  process.exit(2);
}

const title = 'Why the cheapest AI video model is usually the expensive one';
const angle =
  'Cost per generation is the wrong unit. The number that matters is cost per clip you ' +
  'actually ship, and a model that costs a third as much but needs four attempts to land ' +
  'a usable shot is more expensive, not less.';

const conceptId = sql(`
  insert into concepts (channel_id, title, angle, rubric_version, status)
  values (${q(channelId)}, ${q(title)}, ${q(angle)}, 'manual-v0', 'approved')
  returning id`);

const channel = JSON.parse(
  sql(`select json_build_object('name', name, 'platform', platform, 'niche', niche)
       from channels where id = ${q(channelId)}`),
);

console.log(`concept  ${conceptId}`);
console.log(`channel  ${channel.name} · ${channel.platform} · ${channel.niche}\n`);

// ── 2. Refuse to spend before the spend can be recorded ──────────────────────
//
// The same rule-5 guard `runScriptDraft` applies, over the same rows: both rates must
// exist and be verified *before* the call, because discovering afterwards that a call
// cannot be priced leaves money spent and unaccounted.
const rateRows = sql(`
  select id || '|' || unit || '|' || unit_cost || '|' || is_verified
  from rate_card
  where driver = 'anthropic' and model = 'claude-opus-5' and endpoint = '/v1/messages'
    and effective_from <= now()
  order by unit, effective_from desc`).split('\n').filter(Boolean);

const rates = {};
for (const line of rateRows) {
  const [id, unit, unitCost, verified] = line.split('|');
  // `||` renders a boolean as 'true'/'false', not psql's 't'/'f' column formatting. The
  // first version of this checked for 't' and refused to spend on a verified rate — the
  // safe direction to be wrong in, and still wrong.
  rates[unit] = { id, unit, unitCostUsd: Number(unitCost), isVerified: verified === 'true' };
}

for (const unit of ['input_token', 'output_token']) {
  if (!rates[unit]) throw new Error(`No rate card row for ${unit}. Refusing to spend.`);
  if (!rates[unit].isVerified) throw new Error(`Rate for ${unit} is unverified. Refusing to spend.`);
}
console.log(
  `rates    input $${rates.input_token.unitCostUsd}/token · output $${rates.output_token.unitCostUsd}/token · both verified\n`,
);

// ── 3. The call ──────────────────────────────────────────────────────────────
const started = Date.now();
const draft = await draftScript({ channel, title, angle, targetSeconds: 30 }, { apiKey });
const elapsed = Date.now() - started;

const hash = structureHash(draft.script);
const usdInrRate = Number(process.env.USD_INR_RATE ?? 94);

// ── 4. The rows, built by the production functions ───────────────────────────
const row = scriptRowFor({ conceptId, version: 1, draft, structureHash: hash });

const scriptId = sql(`
  insert into scripts (concept_id, version, hook, beats, cta, vo_text, drafted_by, draft_raw, structure_hash)
  values (${q(row.concept_id)}, ${row.version}, ${q(row.hook)}, ${q(JSON.stringify(row.beats))}::jsonb,
          ${row.cta === null ? 'null' : q(row.cta)}, ${q(row.vo_text)}, ${q(row.drafted_by)},
          ${q(row.draft_raw)}, ${q(row.structure_hash)})
  returning id`);

const pricing = priceFromRates({
  inputRate: rates.input_token,
  outputRate: rates.output_token,
  usage: draft.usage,
  usdInrRate,
});

const ledger = llmCostRows({ kind: 'script', scriptId, conceptId }, pricing);

for (const r of ledger) {
  sql(`insert into cost_ledger (script_id, concept_id, driver, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate)
       values (${q(r.script_id)}, ${q(r.concept_id)}, ${q(r.driver)}, ${q(r.entry_kind)},
               ${q(r.unit)}, ${r.quantity}, ${r.cost_usd}, ${r.cost_inr}, ${r.usd_inr_rate})`);
}

// ── 5. Read it back. Not what we think we wrote ──────────────────────────────
console.log('═'.repeat(78));
console.log(`GENERATED SCRIPT   ${scriptId}   ${elapsed}ms`);
console.log('═'.repeat(78));

const stored = JSON.parse(
  sql(`select row_to_json(t) from (
         select hook, beats, cta, vo_text, drafted_by, structure_hash, human_edit_count,
                length(draft_raw) as raw_len, length(vo_text) as vo_len
         from scripts where id = ${q(scriptId)}) t`),
);

console.log(`\nHOOK\n  ${stored.hook}\n`);
console.log('BEATS');
for (const [i, b] of stored.beats.entries()) {
  console.log(`  ${String(i)}  ${String(b.t).padStart(4)}s  ${b.text}`);
  console.log(`            intent: ${b.intent}`);
}
console.log(`\nCTA\n  ${stored.cta ?? '(none — a real choice, not a fallback)'}`);
console.log(`\nVO_TEXT  (${stored.vo_len} chars — this is the string that gets synthesised)`);
console.log(`  ${stored.vo_text}`);

console.log(`\nPROVENANCE`);
console.log(`  drafted_by        ${stored.drafted_by}`);
console.log(`  draft_raw         ${stored.raw_len} chars, untouched`);
console.log(`  human_edit_count  ${stored.human_edit_count}  ← publish blocked until > 0`);
console.log(`  structure_hash    ${stored.structure_hash}`);
console.log(
  `                    ${stored.beats.length} beats${stored.cta ? ' + CTA' : ', no CTA'} — the shape, not the words`,
);

console.log(`\n${'═'.repeat(78)}`);
console.log('COST LEDGER  (read back from the table)');
console.log('═'.repeat(78));
console.log(
  sql(`select unit || '  ' || quantity || ' × $' || (cost_usd / quantity)::numeric(12,8) ||
              '  =  $' || cost_usd::numeric(12,6) || '   ₹' || cost_inr::numeric(12,4) ||
              '   [' || entry_kind || ']'
       from cost_ledger where script_id = ${q(scriptId)} order by unit`)
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n'),
);

const totals = sql(`select sum(cost_usd)::numeric(12,6) || '|' || sum(cost_inr)::numeric(12,4) || '|' || max(usd_inr_rate)
                    from cost_ledger where script_id = ${q(scriptId)}`).split('|');
console.log(`\n  TOTAL  $${totals[0]}   ₹${totals[1]}    (FX ${totals[2]}, snapshotted on each row)`);

console.log(`\n  v_script_cost:`);
console.log(
  '  ' +
    sql(`select 'total ₹' || cost_inr::numeric(12,4) || '  ·  draft ₹' || draft_cost_inr::numeric(12,4) ||
                '  ·  generation ₹' || generation_cost_inr::numeric(12,4) || ' (no shots yet)'
         from v_script_cost where script_id = ${q(scriptId)}`),
);

// ── 6. The constraints, exercised rather than assumed ────────────────────────
console.log(`\n${'═'.repeat(78)}`);
console.log('CONSTRAINTS  (attempted against the real rows, not asserted)');
console.log('═'.repeat(78));

const expectFailure = (label, statement) => {
  try {
    sql(statement);
    console.log(`  NOT ENFORCED  ${label}`);
    return false;
  } catch (err) {
    const msg = String(err.stderr ?? err.message).match(/ERROR:\s*(.+)/)?.[1] ?? 'rejected';
    console.log(`  rejected      ${label}\n                ${msg.slice(0, 90)}`);
    return true;
  }
};

expectFailure(
  'charging the same script twice for input tokens',
  `insert into cost_ledger (script_id, concept_id, driver, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate)
   values (${q(scriptId)}, ${q(conceptId)}, 'anthropic', 'reconcile', 'input_token', 1, 1, 1, ${usdInrRate})`,
);
expectFailure(
  'a ledger row attributing spend to nothing',
  `insert into cost_ledger (driver, entry_kind, unit, quantity, cost_usd) values ('anthropic','reconcile','input_token',1,1)`,
);
expectFailure(
  'a second script at the same version',
  `insert into scripts (concept_id, version, hook, beats, vo_text, drafted_by, structure_hash)
   values (${q(conceptId)}, 1, 'x', '[]'::jsonb, 'x', 'x', 'x')`,
);

console.log(`\nconcept ${conceptId}\nscript  ${scriptId}`);
