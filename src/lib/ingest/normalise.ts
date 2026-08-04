import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The canonical intermediate.
 *
 * Every asset is normalised to this shape **on ingest**, not at assembly time, and that
 * ordering is the whole reason the rough cut can use ffmpeg's concat demuxer at all:
 * concat requires identical codec, resolution, framerate and pixel format across inputs,
 * and re-encoding six clips at assembly time is both slow and lossy. Normalising once, at
 * the point the file arrives, makes assembly a stream copy.
 *
 * The vendor returns whatever it returns — resolutions vary by model, framerates vary by
 * motion preset, and a still-image driver returns something with no framerate at all. None
 * of that is knowable in advance, which is why this converts rather than validates.
 */
export const CANONICAL = {
  width: 1080,
  height: 1920,
  fps: 30,
  vcodec: 'h264',
  pixFmt: 'yuv420p',
} as const;

export interface ProbeResult {
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixFmt: string;
  durationS: number;
  hasAudio: boolean;
}

export interface NormaliseResult {
  ok: boolean;
  /** What the input turned out to be. Stored on the asset as `source_meta`. */
  source: ProbeResult | null;
  output: ProbeResult | null;
  error: string | null;
  ms: number;
}

/** ffprobe, parsed. Throws on anything ffprobe cannot read, which is the corrupt case. */
export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    path,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: {
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      avg_frame_rate?: string;
    }[];
    format?: { duration?: string };
  };

  const video = (parsed.streams ?? []).find((s) => s.codec_type === 'video');
  if (!video) throw new Error('No video stream. ffprobe read the container but found nothing to play.');

  // avg_frame_rate is a rational: "30/1", "30000/1001". Evaluated rather than parsed as a
  // float, because 30000/1001 is 29.97 and rounding it to 30 before the comparison would
  // make a mismatched clip look canonical.
  const [num, den] = (video.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = den ? num / den : 0;

  // ── Unreadable is not zero ───────────────────────────────────────────────
  //
  // These were `?? 0`, and the consequence is the worst instance of that mistake in this
  // codebase. A probe that could not report dimensions returned 0×0, `isCanonical` compared
  // 0 against 1080 and said no, and the pipeline **re-encoded the file** — taking the repair
  // path for a file whose properties are unknown rather than reporting that it could not be
  // read. Duration was the same: `0`, flowing into the assembler as a real number, in the
  // one path where a wrong duration has already produced three bugs that made a file which
  // plays and is wrong.
  //
  // Throwing is right and consistent: this function already throws when there is no video
  // stream, and `runIngest` turns a throw into an error row rather than an exception, so a
  // corrupt asset becomes a row that names the problem.
  const missing: string[] = [];
  if (video.width === undefined) missing.push('width');
  if (video.height === undefined) missing.push('height');
  if (!den || !Number.isFinite(fps) || fps <= 0) missing.push('frame rate');
  const durationRaw = parsed.format?.duration;
  if (durationRaw === undefined || !Number.isFinite(Number(durationRaw))) {
    missing.push('duration');
  }

  if (missing.length > 0) {
    throw new Error(
      `ffprobe read the container but could not report ${missing.join(', ')}. Refusing to ` +
        'treat an unreadable property as zero: 0×0 would fail the canonical check and send ' +
        'this file down the re-encode path, and a duration of 0 would reach the assembler ' +
        'as a measurement.',
    );
  }

  return {
    width: video.width!,
    height: video.height!,
    fps,
    codec: video.codec_name ?? 'unknown',
    pixFmt: video.pix_fmt ?? 'unknown',
    durationS: Number(durationRaw),
    hasAudio: (parsed.streams ?? []).some((s) => s.codec_type === 'audio'),
  };
}

/** Whether a file is already the canonical intermediate. What the assembler checks. */
export function isCanonical(p: ProbeResult): boolean {
  return (
    p.width === CANONICAL.width &&
    p.height === CANONICAL.height &&
    Math.abs(p.fps - CANONICAL.fps) < 0.01 &&
    p.codec === CANONICAL.vcodec &&
    p.pixFmt === CANONICAL.pixFmt
  );
}

/**
 * Convert an arbitrary input to the canonical intermediate.
 *
 * **scale-then-pad, never crop.** A 16:9 clip padded into 9:16 keeps the whole frame with
 * bars; cropped, it silently loses the sides — and the sides are where a generated subject
 * often is. A visible bar is a decision someone can see and fix. A cropped face is not.
 *
 * `force_original_aspect_ratio=decrease` scales the longest edge to fit, then `pad` centres
 * it. `setsar=1` because a non-square sample aspect ratio survives scaling and makes the
 * output geometrically canonical while still playing back stretched.
 *
 * Audio is normalised too — concat is as strict about audio parameters as video, and a
 * clip with no audio track at all breaks the demuxer differently from one with the wrong
 * sample rate. `-shortest` with a silent source gives every clip an identical track.
 */
export async function normalise(
  inputPath: string,
  outputPath: string,
): Promise<NormaliseResult> {
  const started = Date.now();

  let source: ProbeResult | null = null;
  try {
    source = await probe(inputPath);
  } catch (err) {
    return {
      ok: false,
      source: null,
      output: null,
      error: `Unreadable input: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      ms: Date.now() - started,
    };
  }

  const filter =
    `scale=${CANONICAL.width}:${CANONICAL.height}:force_original_aspect_ratio=decrease,` +
    `pad=${CANONICAL.width}:${CANONICAL.height}:(ow-iw)/2:(oh-ih)/2,` +
    `setsar=1,fps=${CANONICAL.fps}`;

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', inputPath,
  ];

  // A silent track when the source has none, so every normalised clip has the same stream
  // layout. The concat demuxer refuses a set where one input has audio and another does
  // not, and it refuses it with a message about timestamps rather than about audio.
  if (!source.hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-shortest');
  }

  args.push(
    '-vf', filter,
    '-c:v', 'libx264',
    '-pix_fmt', CANONICAL.pixFmt,
    '-profile:v', 'high',
    '-preset', 'veryfast',
    '-crf', '20',
    // Closed GOP with a fixed keyframe interval. The concat demuxer stream-copies, so a
    // segment that starts mid-GOP plays as corruption until the next keyframe.
    '-g', String(CANONICAL.fps * 2),
    '-keyint_min', String(CANONICAL.fps * 2),
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    outputPath,
  );

  try {
    await run('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      source,
      output: null,
      // ffmpeg's useful line is the last one; the rest is the command echo.
      error: message.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 500),
      ms: Date.now() - started,
    };
  }

  // Probed again rather than assumed. "ffmpeg exited zero" and "the file is canonical" are
  // different claims, and the second is the one the assembler depends on.
  try {
    const output = await probe(outputPath);
    if (!isCanonical(output)) {
      return {
        ok: false,
        source,
        output,
        error:
          `ffmpeg succeeded but the output is not canonical: ${output.width}x${output.height} ` +
          `${output.fps.toFixed(2)}fps ${output.codec}/${output.pixFmt}.`,
        ms: Date.now() - started,
      };
    }
    return { ok: true, source, output, error: null, ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      source,
      output: null,
      error: `Output unreadable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      ms: Date.now() - started,
    };
  }
}
