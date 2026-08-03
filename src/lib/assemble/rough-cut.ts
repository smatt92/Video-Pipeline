import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { CANONICAL, isCanonical, probe, type ProbeResult } from '../ingest/normalise';

const run = promisify(execFile);

/**
 * The rough cut — Addendum 02 §3.
 *
 * ffmpeg's **concat demuxer**, not the concat filter. The distinction is the whole design:
 * the demuxer stream-copies, so six clips join in well under a second with no quality loss
 * and no second encode; the filter re-encodes everything and would take longer than
 * generating the clips did.
 *
 * The price of that is strictness. The demuxer requires every input to share codec,
 * resolution, framerate, pixel format, and audio parameters — it does not convert, it
 * concatenates byte ranges. Give it a mismatched set and it does not error: it produces a
 * file whose later segments are garbage, or whose timestamps run backwards so players
 * report a duration of several hours.
 *
 * **That is why ingest normalises rather than assembly.** By the time a clip is in the
 * bucket it is already the canonical intermediate, and this function's job reduces to
 * checking that assumption held and refusing when it did not. The check is not
 * belt-and-braces — a silently broken MP4 is the single worst artifact this pipeline could
 * produce, because it looks like a success everywhere except in a player.
 */

export interface ClipInput {
  /** Local path the worker can read. The caller resolves this from the storage driver. */
  path: string;
  /** For the error message when this is the clip that does not match. */
  label: string;
}

export type AssembleResult =
  | {
      ok: true;
      outputPath: string;
      durationS: number;
      clips: number;
      /** Sum of the inputs, for the arithmetic check against the output. */
      expectedDurationS: number;
      renderMs: number;
      probe: ProbeResult;
    }
  | { ok: false; code: 'not_canonical' | 'unreadable' | 'ffmpeg' | 'mismatch'; detail: string };

/**
 * The concat list file.
 *
 * Paths are single-quoted and internal quotes escaped, because the demuxer's list format
 * treats an unescaped quote as a syntax error and a space as a separator. A generated path
 * containing either is not hypothetical once keys carry titles.
 */
function concatList(clips: ClipInput[]): string {
  return clips.map((c) => `file '${c.path.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

export async function assembleRoughCut(params: {
  clips: ClipInput[];
  outputPath: string;
  workDir: string;
}): Promise<AssembleResult> {
  const { clips, outputPath, workDir } = params;
  const started = Date.now();

  if (clips.length === 0) {
    return { ok: false, code: 'mismatch', detail: 'No clips to assemble.' };
  }

  // ── Every clip must already be canonical ─────────────────────────────────
  //
  // Checked before ffmpeg is invoked, and each mismatch named individually. "One of your
  // clips is wrong" sends someone through six files by hand; naming the clip and the two
  // shapes is the difference between a minute and an afternoon.
  const shapes: ProbeResult[] = [];
  const offenders: string[] = [];

  for (const clip of clips) {
    let shape: ProbeResult;
    try {
      shape = await probe(clip.path);
    } catch (err) {
      return {
        ok: false,
        code: 'unreadable',
        detail: `${clip.label}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      };
    }
    shapes.push(shape);

    if (!isCanonical(shape)) {
      offenders.push(
        `${clip.label} is ${shape.width}x${shape.height} ${shape.fps.toFixed(2)}fps ` +
          `${shape.codec}/${shape.pixFmt}`,
      );
    }
  }

  if (offenders.length > 0) {
    return {
      ok: false,
      code: 'not_canonical',
      detail:
        `${offenders.length} of ${clips.length} clips are not the canonical intermediate ` +
        `(${CANONICAL.width}x${CANONICAL.height} ${CANONICAL.fps}fps ${CANONICAL.vcodec}/` +
        `${CANONICAL.pixFmt}):\n  ${offenders.join('\n  ')}\n\n` +
        'Refusing rather than concatenating. The demuxer stream-copies, so a mismatched set ' +
        'does not fail — it produces a file whose later segments are unplayable and whose ' +
        'duration is wrong, which looks like a success everywhere except in a player. ' +
        'These clips were not normalised at ingest; re-run 05b-ingest for them.',
    };
  }

  // ── Concat ───────────────────────────────────────────────────────────────
  const listPath = join(workDir, 'concat.txt');
  await writeFile(listPath, concatList(clips));

  try {
    await run(
      'ffmpeg',
      [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat',
        // The list references absolute paths outside the list's own directory, which the
        // demuxer refuses by default — it is a deliberate guard against a list file from an
        // untrusted source reading arbitrary paths. Ours is generated two lines above.
        '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: 'ffmpeg',
      detail: message.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 500),
    };
  }

  // ── Verify the output ────────────────────────────────────────────────────
  //
  // The arithmetic is the real check. A concat that silently drops a segment still exits
  // zero and still produces a playable file — it is just shorter than the sum of its
  // parts, and nothing else here would notice.
  const expected = shapes.reduce((sum, s) => sum + s.durationS, 0);

  let output: ProbeResult;
  try {
    output = await probe(outputPath);
  } catch (err) {
    return {
      ok: false,
      code: 'unreadable',
      detail: `Output: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }

  const drift = Math.abs(output.durationS - expected);
  if (drift > 0.5) {
    return {
      ok: false,
      code: 'mismatch',
      detail:
        `Output is ${output.durationS.toFixed(2)}s but the inputs sum to ${expected.toFixed(2)}s ` +
        `(${drift.toFixed(2)}s adrift). A segment was dropped or the timestamps did not join.`,
    };
  }

  return {
    ok: true,
    outputPath,
    durationS: output.durationS,
    expectedDurationS: expected,
    clips: clips.length,
    renderMs: Date.now() - started,
    probe: output,
  };
}
