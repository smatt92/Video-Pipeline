#!/usr/bin/env node
/**
 * Run stage 3 for real. One concept in, one script and its cost rows out.
 *
 * This is not a test. It makes a billed call to the real Messages API and writes real rows
 * to whichever Supabase project the environment points at. CLAUDE.md rule 8: a feature is
 * done when it has been triggered in a real run against real APIs, and passing tests with
 * a mocked driver is not done.
 *
 * It calls `runScriptDraft` — the same function the Trigger task calls, with the same
 * database client. There is no second implementation here to drift from the first.
 *
 *   pnpm verify:script                        # drafts against the seeded dev channel
 *   pnpm verify:script <concept-uuid>         # drafts an existing concept
 *
 * Needs, in .env.local or the environment:
 *   ANTHROPIC_API_KEY
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   USD_INR_RATE                              (optional, defaults to 88.5)
 *
 * Expect it to cost a fraction of a rupee. It prints the exact figure, from the ledger row
 * rather than from its own arithmetic.
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync } from 'node:fs';

// `pnpm verify:script` compiles the library to CommonJS first (tsconfig.verify.json). The
// point of importing the compiled output rather than reimplementing anything is that this
// runs the *same* function the Trigger task runs — a verification path with its own copy
// of the logic verifies the copy.
const BUILD = '../.verify-build/src/lib/script/run.js';

if (!existsSync(new URL(BUILD, import.meta.url))) {
  console.error('Run this via `pnpm verify:script` — it compiles the library first.');
  process.exit(2);
}

const need = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(
      `\n${name} is not set.\n\n` +
        'This script makes a real, billed API call and writes real rows. It has no offline\n' +
        'mode on purpose — a mocked run of this would prove nothing that the type checker\n' +
        'has not already proved.\n',
    );
    process.exit(2);
  }
  return v;
};

const apiKey = need('ANTHROPIC_API_KEY');
const supabaseUrl = need('NEXT_PUBLIC_SUPABASE_URL');
const serviceKey = need('SUPABASE_SERVICE_ROLE_KEY');
const usdInrRate = Number(process.env.USD_INR_RATE ?? 88.5);

const db = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { runScriptDraft } = await import(BUILD);

// ── Pick a concept ───────────────────────────────────────────────────────────
let conceptId = process.argv[2];

if (!conceptId) {
  const { data: channel, error } = await db
    .from('channels')
    .select('id, name')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error || !channel) {
    console.error('No active channel. Concepts cannot exist without one — run the seed first.');
    process.exit(2);
  }

  const { data: concept, error: insertError } = await db
    .from('concepts')
    .insert({
      channel_id: channel.id,
      title: 'Why the cheapest AI video model is usually the expensive one',
      angle:
        'Cost per generation is the wrong unit. The number that matters is cost per clip ' +
        'you actually ship, and a model that costs a third as much but needs four attempts ' +
        'to land a usable shot is more expensive, not less.',
      rubric_version: 'manual-v0',
      status: 'approved',
    })
    .select('id, title')
    .single();

  if (insertError || !concept) {
    console.error('Could not create a concept to draft:', insertError?.message);
    process.exit(1);
  }

  conceptId = concept.id;
  console.log(`Created concept ${conceptId}\n  ${concept.title}\n`);
}

// ── Run it ───────────────────────────────────────────────────────────────────
const runId = `verify-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
console.log(`Drafting (runId ${runId})…\n`);

const result = await runScriptDraft(
  { conceptId, targetSeconds: 30 },
  {
    db,
    apiKey,
    usdInrRate,
    runId,
    log: { info: (m, d) => console.log(`  · ${m}`, d ?? ''), error: (m, d) => console.error(`  ! ${m}`, d ?? '') },
  },
);

if (!result.ok) {
  console.error(`\nDraft failed: ${result.code}\n  ${result.detail}`);
  console.error(
    result.costInr === null
      ? '  No charge recorded — the call did not reach the model.'
      : `  Charged ₹${result.costInr.toFixed(4)} anyway; a refused call is billed like any other.`,
  );
  process.exit(1);
}

// ── Read back what landed. Not what we think we wrote ────────────────────────
const { data: script } = await db
  .from('scripts')
  .select('id, version, hook, beats, cta, vo_text, drafted_by, draft_raw, structure_hash, human_edit_count, created_at')
  .eq('id', result.scriptId)
  .single();

const { data: ledger } = await db
  .from('cost_ledger')
  .select('unit, quantity, cost_usd, cost_inr, usd_inr_rate, entry_kind, driver, occurred_at')
  .eq('script_id', result.scriptId)
  .order('unit');

console.log('\n─── SCRIPT ' + '─'.repeat(58));
console.log(`id            ${script.id}  (v${script.version})`);
console.log(`drafted_by    ${script.drafted_by}`);
console.log(`structure     ${script.structure_hash.slice(0, 16)}…`);
console.log(`human edits   ${script.human_edit_count}  ← publish is blocked until this is > 0`);
console.log(`\nHOOK\n  ${script.hook}`);
console.log('\nBEATS');
for (const [i, b] of script.beats.entries()) {
  console.log(`  ${String(i).padStart(2)}  ${String(b.t).padStart(4)}s  ${b.text}`);
  console.log(`      ${' '.repeat(5)} intent: ${b.intent}`);
}
console.log(`\nCTA\n  ${script.cta ?? '(none — a real choice, not a fallback)'}`);
console.log(`\nVO_TEXT (${script.vo_text.length} chars — this is what gets synthesised)\n  ${script.vo_text}`);
console.log(`\ndraft_raw is ${script.draft_raw.length} chars of untouched model output.`);

console.log('\n─── COST LEDGER ' + '─'.repeat(53));
let usd = 0;
let inr = 0;
for (const row of ledger) {
  usd += Number(row.cost_usd);
  inr += Number(row.cost_inr);
  console.log(
    `${row.unit.padEnd(13)} ${String(row.quantity).padStart(7)} × $${(Number(row.cost_usd) / Number(row.quantity)).toFixed(8)}` +
      ` = $${Number(row.cost_usd).toFixed(6)}  ₹${Number(row.cost_inr).toFixed(4)}   [${row.entry_kind}]`,
  );
}
console.log(`${''.padEnd(13)} ${' '.repeat(7)}   ${' '.repeat(20)}   $${usd.toFixed(6)}  ₹${inr.toFixed(4)}`);
console.log(`\nFX ${ledger[0]?.usd_inr_rate} snapshotted on the row, so this rupee figure stays explainable.`);

const { data: rolled } = await db
  .from('v_script_cost')
  .select('cost_inr, draft_cost_inr, generation_cost_inr')
  .eq('script_id', result.scriptId)
  .maybeSingle();

console.log(
  `\nv_script_cost: ₹${Number(rolled?.cost_inr ?? 0).toFixed(4)} ` +
    `(draft ₹${Number(rolled?.draft_cost_inr ?? 0).toFixed(4)}, ` +
    `generation ₹${Number(rolled?.generation_cost_inr ?? 0).toFixed(4)} — no shots yet)`,
);
