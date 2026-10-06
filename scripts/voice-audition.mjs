#!/usr/bin/env node
/**
 * pnpm voice:audition — hear every character in candidate Runway preset voices, then pick.
 *
 * Renders the same two lines per character (from their voice_brief and catchphrase) in each
 * candidate preset, into ./out/audition/<character>/<preset>.mp3. Writes NOTHING to
 * characters.json — Sahil listens, then runs `pnpm voice:lock <character> <preset>`.
 *
 * Money: every render is priced before it is made (characters × 1 credit/50 × $0.01) and the
 * whole run is refused up front if it would exceed --max-usd (default 1.00). Each render
 * writes a cost_ledger row against the channel, so DATABASE_URL is required — rule 5 has no
 * exception for auditions.
 *
 *   RUNWAY_API_KEY=... DATABASE_URL=... pnpm voice:audition \
 *     [--characters pip,marlo] [--presets Maya,Arjun,Serene] [--max-usd 1.00] [--list]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { TTS_PRESET_IDS } = require(`${B}/drivers/voice-route.js`);
const { submitSpeech, waitForTask, CREDIT_USD } = require(`${B}/drivers/voice-runway.js`);
const { BIBLE, BUREAU_CHANNEL_ID } = require(`${B}/bureau/bible.js`);

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};

if (process.argv.includes('--list')) {
  console.log(`Runway TTS presets (${TTS_PRESET_IDS.length}):\n  ${TTS_PRESET_IDS.join(', ')}`);
  process.exit(0);
}

const apiKey = process.env.RUNWAY_API_KEY;
const dbUrl = process.env.DATABASE_URL;
if (!apiKey || !dbUrl) {
  console.error('RUNWAY_API_KEY and DATABASE_URL are both required (the second for the cost rows).');
  process.exit(2);
}
const chars = (arg('characters', '') || BIBLE.characters.map((c) => c.id).join(',')).split(',').map((s) => s.trim());
const presets = (arg('presets', 'Maya,Arjun,Serene,Bernard,Eleanor,Elias')).split(',').map((s) => s.trim());
const maxUsd = Number(arg('max-usd', '1.00'));
const bad = presets.filter((p) => !TTS_PRESET_IDS.includes(p));
if (bad.length) {
  console.error(`Unknown preset(s): ${bad.join(', ')}. Run with --list.`);
  process.exit(2);
}

const lines = (c) => [`${c.name} here. ${c.voice_brief}`, c.catchphrase.text];
const plan = chars.flatMap((id) => {
  const c = BIBLE.characters.find((x) => x.id === id);
  if (!c) throw new Error(`No character "${id}"`);
  return presets.flatMap((p) => lines(c).map((text, n) => ({ c, p, n, text })));
});
const credits = plan.reduce((t, r) => t + Math.ceil(r.text.length / 50), 0);
const usd = credits * CREDIT_USD;
console.log(`\n${plan.length} renders, ~${credits} credits, ~$${usd.toFixed(2)} (limit $${maxUsd.toFixed(2)})\n`);
if (usd > maxUsd) {
  console.error(`Refusing: the audition would cost ~$${usd.toFixed(2)}, over --max-usd ${maxUsd}. Narrow --characters or --presets.`);
  process.exit(1);
}

const pg = (await import('pg')).default;
const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const { rows: fx } = await client.query('select usd_inr_rate from profiles where usd_inr_rate is not null limit 1');
const rate = fx[0] ? Number(fx[0].usd_inr_rate) : null;
if (rate === null) {
  console.error('No USD→INR rate in profiles; the cost rows cannot be priced. Set it in Settings → Workspace.');
  process.exit(1);
}

for (const r of plan) {
  const dir = join('out', 'audition', r.c.id);
  await mkdir(dir, { recursive: true });
  const chars = r.text.length;
  const costUsd = chars * 0.0002;
  await client.query(
    `insert into cost_ledger (channel_id, driver, stage, entry_kind, unit, quantity, cost_usd, cost_inr, usd_inr_rate, idempotency_key, cost_source)
     values ($1, 'runway', 'voice-audition', 'estimate', 'character', $2, $3, $4, $5, $6, 'rate_card')`,
    [BUREAU_CHANNEL_ID, chars, costUsd, costUsd * rate, rate, `audition:${r.c.id}:${r.p}:${r.n}:${Date.now()}`],
  );
  const started = await submitSpeech({ apiKey, text: r.text, presetId: r.p, model: 'eleven_v3', languageCode: 'en' });
  if (!started.ok) {
    console.error(`  ✗ ${r.c.id}/${r.p}/${r.n}: ${started.code} ${started.detail}`);
    continue;
  }
  const done = await waitForTask({ apiKey, taskId: started.taskId, maxWaitMs: 180_000 });
  if (done.state !== 'succeeded') {
    console.error(`  ✗ ${r.c.id}/${r.p}/${r.n}: ${done.state === 'failed' ? done.detail : 'timeout'}`);
    continue;
  }
  const audio = Buffer.from(await (await fetch(done.outputUrl)).arrayBuffer());
  const file = join(dir, `${r.p}-${r.n + 1}.mp3`);
  await writeFile(file, audio);
  console.log(`  ✓ ${file}`);
}
await client.end();
console.log('\nListen, then: pnpm voice:lock <character> <preset>   (one per character), and commit.\n');
