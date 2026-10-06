#!/usr/bin/env node
/**
 * test:align — the forced aligner against audio whose word boundaries are known exactly.
 *
 * The "vendor" audio is built here from per-word espeak-ng synthesis in a DIFFERENT voice,
 * speed and pitch from the aligner's reference, joined with random pauses — so the true
 * boundary of every word is a number this harness wrote down before the aligner ran, and the
 * two sides of each assertion arrive by independent routes. Needs ffmpeg and espeak-ng (CI
 * installs both; the worker image declares both).
 *
 * LOAD-BEARING: the mismatch case. An aligner that always "succeeds" would pass every
 * accuracy check on matched audio; only feeding it the wrong sentence shows it can refuse.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const B = new URL('../.verify-build/src/lib', import.meta.url).pathname;
const { alignLine, decodePcm, scriptWords, SAMPLE_RATE } = require(`${B}/voice/align.js`);

let failures = 0;
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
};

const dir = await mkdtemp(join(tmpdir(), 'kiln-test-align-'));
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

async function speak(text, voice, speed, pitch, out) {
  await run('espeak-ng', ['-v', voice, '-s', String(speed), '-p', String(pitch), '-w', out, text]);
  return decodePcm(out);
}
function trim(p) {
  let a = 0, b = p.length - 1;
  while (a < b && Math.abs(p[a]) < 0.01) a++;
  while (b > a && Math.abs(p[b]) < 0.01) b--;
  return p.slice(a, b + 1);
}
/** Target audio + its true boundaries, built word by word. */
async function target(text, name) {
  const words = scriptWords(text);
  const parts = [];
  const truth = [];
  let t = Math.round(SAMPLE_RATE * 0.3);
  parts.push(new Float32Array(t));
  for (const [i, w] of words.entries()) {
    const pcm = trim(await speak(w, 'en-gb+m3', 150, 35, join(dir, `${name}-${i}.wav`)));
    truth.push({ w, start: t / SAMPLE_RATE, end: (t + pcm.length) / SAMPLE_RATE });
    const gap = new Float32Array(Math.round(SAMPLE_RATE * (0.03 + rand() * 0.2)));
    parts.push(pcm, gap);
    t += pcm.length + gap.length;
  }
  parts.push(new Float32Array(Math.round(SAMPLE_RATE * 0.4)));
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  const raw = join(dir, `${name}.f32`);
  await writeFile(raw, Buffer.from(all.buffer));
  const wav = join(dir, `${name}.wav`);
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', raw, wav]);
  return { wav, truth };
}

try {
  console.log('\nforced alignment\n');
  const lineA = 'The Moon holds the tides, so no Moon means smaller tides by Friday.';
  const lineB = 'Calendars drift because a year is not a whole number of days.';
  const a = await target(lineA, 'a');
  const r = await alignLine({ audioPath: a.wav, text: lineA });
  check(r.ok, 'matched audio aligns', r.ok ? `cost ratio ${r.costRatio.toFixed(2)}` : `${r.code}: ${r.detail}`);
  if (r.ok) {
    check(r.words.length === scriptWords(lineA).length, 'aligned word count === script word count', `${r.words.length}`);
    check(r.words.map((w) => w.w).join(' ') === lineA, 'the words are the script tokens, in order');
    const errs = r.words.map((w, i) => Math.abs(w.start - a.truth[i].start));
    const mean = errs.reduce((x, y) => x + y, 0) / errs.length;
    check(mean < 0.08, 'mean word-start error under 80 ms', `${(mean * 1000).toFixed(0)} ms`);
    check(Math.max(...errs) < 0.2, 'worst word-start error under 200 ms', `${(Math.max(...errs) * 1000).toFixed(0)} ms`);
  }
  const wrong = await alignLine({ audioPath: a.wav, text: lineB });
  check(!wrong.ok && wrong.code === 'low_confidence', 'LOAD-BEARING: the wrong sentence is refused, not aligned', wrong.ok ? `accepted at ratio ${wrong.costRatio.toFixed(2)}` : `${wrong.code} ratio ${wrong.costRatio?.toFixed(2) ?? ''}`);
  const b = await target(lineB, 'b');
  const rb = await alignLine({ audioPath: b.wav, text: lineB });
  check(rb.ok, 'a second matched line aligns', rb.ok ? `cost ratio ${rb.costRatio.toFixed(2)}` : rb.detail);
  // Short lines are where a weak null fails: a five-word line reordered still sounds like itself.
  const shortA = 'Tides are now on strike.';
  const sa = await target(shortA, 'sa');
  const rs = await alignLine({ audioPath: sa.wav, text: shortA });
  check(rs.ok, 'a five-word line aligns', rs.ok ? `cost ratio ${rs.costRatio.toFixed(2)}` : rs.detail);
  const rsWrong = await alignLine({ audioPath: sa.wav, text: 'The Sun still pulls hard.' });
  check(!rsWrong.ok, 'and a different five-word line is refused against it', rsWrong.ok ? `accepted at ${rsWrong.costRatio.toFixed(2)}` : `ratio ${rsWrong.costRatio?.toFixed(2)}`);
  const missing = await alignLine({ audioPath: join(dir, 'nope.wav'), text: lineA });
  check(!missing.ok && missing.code === 'unreadable', 'an unreadable file is refused as unreadable, never as zero timings');
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} FAILED\n` : '\nAlignment checks passed.\n');
process.exit(failures ? 1 : 0);
