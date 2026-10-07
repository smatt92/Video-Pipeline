#!/usr/bin/env node
/**
 * pnpm voice:lock <character> <preset> — write Sahil's audition pick into characters.json.
 *
 * The only writer of `voice.preset_id`. Edits the one line in place (formatting preserved),
 * validates the preset against the vendor's list, and leaves the commit to you: the bible is
 * source-controlled, and a locked voice is an editorial decision with an author.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TTS_PRESET_IDS } = require(new URL('../.verify-build/src/lib/drivers/voice-route.js', import.meta.url).pathname);

const [character, preset] = process.argv.slice(2);
if (!character || !preset) {
  console.error('usage: pnpm voice:lock <character> <preset>');
  process.exit(2);
}
if (!TTS_PRESET_IDS.includes(preset)) {
  console.error(`"${preset}" is not a Runway preset. Known: ${TTS_PRESET_IDS.join(', ')}`);
  process.exit(2);
}
// --channel <slug>; the Bureau when omitted.
const CHANNEL_SLUG = process.argv.includes('--channel') ? process.argv[process.argv.indexOf('--channel') + 1] : 'bureau-of-reality';
const path = new URL(`../channels/${CHANNEL_SLUG}/characters.json`, import.meta.url).pathname;
const text = readFileSync(path, 'utf8');
const data = JSON.parse(text);
const c = data.characters.find((x) => x.id === character);
if (!c) {
  console.error(`No character "${character}". Known: ${data.characters.map((x) => x.id).join(', ')}`);
  process.exit(2);
}
// Replace the voice line inside this character's block only.
const start = text.indexOf(`"id": "${character}"`);
const end = text.indexOf('"never_do"', start);
const block = text.slice(start, end);
const next = block.replace(/"voice": \{ "provider": "runway", "preset_id": (null|"[A-Za-z]+") \}/, `"voice": { "provider": "runway", "preset_id": "${preset}" }`);
if (next === block) {
  console.error(`${character}'s voice is not on the runway provider (or the line is not in the expected shape); edit it by hand.`);
  process.exit(1);
}
writeFileSync(path, text.slice(0, start) + next + text.slice(end));
JSON.parse(readFileSync(path, 'utf8'));
console.log(`Locked ${c.name} → ${preset}. Commit channels/${CHANNEL_SLUG}/characters.json to make it live.`);
