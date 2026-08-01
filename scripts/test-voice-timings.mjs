#!/usr/bin/env node
/**
 * Unit tests for the character→word converter and the shot-duration derivation.
 *
 * The only part of stage 6 that can be proven without the vendor, so it is the part that
 * gets tested. Everything it asserts is true *of the documented response shape* — see
 * src/lib/voice/__fixtures__/README.md for why that distinction matters, and 0008 §7 for
 * the command that replaces the fixture with a captured one.
 *
 *   pnpm test:timings
 */
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

const B = '../.verify-build/src/lib/voice';
if (!existsSync(new URL(`${B}/timings.js`, import.meta.url))) {
  console.error('Compile first: npx tsc -p tsconfig.verify.json');
  process.exit(2);
}

const { wordsFromCharacters, takeDuration, shiftBy, deriveShotDurations, TtsResponseSchema } =
  await import(`${B}/timings.js`);

const fixture = JSON.parse(
  readFileSync(new URL('../src/lib/voice/__fixtures__/documented-shape.json', import.meta.url), 'utf8'),
);

let failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
};
const throws = (name, fn, match) => {
  try { fn(); failed++; console.log(`FAIL  ${name} — did not throw`); }
  catch (e) {
    const ok = !match || match.test(e.message);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }
};

console.log('── the response schema ──');
eq('accepts the documented shape', TtsResponseSchema.safeParse(fixture).success, true);
eq(
  'REJECTS a response with only the raw alignment',
  TtsResponseSchema.safeParse({ audio_base64: 'x', alignment: fixture.alignment }).success,
  false,
);

console.log('\n── characters to words ──');
const words = wordsFromCharacters(fixture.normalized_alignment);
eq('word count', words.length, 4);
eq('the words', words.map((w) => w.w), ['GTA', 'cost', 'five', 'dollars.']);
eq('first word spans its characters', [words[0].start, words[0].end], [0.0, 0.36]);
eq('whitespace belongs to no word', words[1].start, 0.40);
eq('take duration is the last end', takeDuration(words), 1.80);

console.log('\n── the substitution the raw alignment would get wrong ──');
const raw = wordsFromCharacters(fixture.alignment);
eq('raw alignment yields "$5." as one token', raw.map((w) => w.w), ['GTA', 'cost', '$5.']);
console.log(
  '      normalized gives "five dollars." across 1.20-1.80s; raw gives "$5." starting at 0.80s.',
);
console.log('      A shot boundary drawn from the raw timings lands 0.4s early on this line.');

console.log('\n── malformed input is loud, not silently wrong ──');
throws(
  'mismatched array lengths throw',
  () => wordsFromCharacters({ characters: ['a', 'b'], character_start_times_seconds: [0], character_end_times_seconds: [1] }),
  /disagree/,
);

console.log('\n── offsets across chunk seams ──');
eq('shiftBy moves both ends', shiftBy([{ w: 'x', start: 1, end: 2 }], 10), [{ w: 'x', start: 11, end: 12 }]);

console.log('\n── shot durations from spans ──');
const voText = 'GTA cost five dollars.';
const derived = deriveShotDurations(
  [
    { shotId: 's0', idx: 0, voCharStart: 0, voCharEnd: 8, authoredDurationS: 99 },
    { shotId: 's1', idx: 1, voCharStart: 9, voCharEnd: 22, authoredDurationS: 99 },
    { shotId: 's2', idx: 2, voCharStart: null, voCharEnd: null, authoredDurationS: 3 },
  ],
  voText,
  words,
);
eq('shot 0 "GTA cost" measured', [derived[0].source, derived[0].durationS], ['derived_from_vo', 0.74]);
eq('shot 1 "five dollars." measured', [derived[1].source, derived[1].durationS], ['derived_from_vo', 1]);
eq('silent shot keeps its authored duration', [derived[2].source, derived[2].durationS], ['authored', 3]);
eq('and says why', /covers no speech/.test(derived[2].reason ?? ''), true);

const drifted = deriveShotDurations(
  [{ shotId: 'x', idx: 0, voCharStart: 900, voCharEnd: 950, authoredDurationS: 4 }],
  voText,
  words,
);
eq('a span past the end falls back rather than collapsing to zero', [drifted[0].source, drifted[0].durationS], ['authored', 4]);
eq('and names the drift', /drifted apart/.test(drifted[0].reason ?? ''), true);

console.log(`\n${failed === 0 ? 'all passed' : `${failed} FAILED`}`);
process.exit(failed ? 1 : 0);
