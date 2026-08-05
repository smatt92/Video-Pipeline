import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CompositionPlan } from './composition';

const run = promisify(execFile);

/**
 * Render the final composition to a file, and prove the file is the length it should be.
 *
 * ── The assertion is on the render, not only in the harness ──────────────────
 *
 * All three duration bugs this project has shipped came out of this path, and every one of
 * them produced **a file that plays and is wrong** — the failure mode nothing downstream can
 * detect, because an MP4 of the wrong length is still a valid MP4. A harness assertion would
 * have caught them in CI and missed them in production, which is the wrong way round: the
 * expensive case is the one where clips have been generated and paid for.
 *
 * So `renderComposition` measures its own output with ffprobe and refuses to return a path
 * it cannot vouch for. The tolerance is one frame, because a container's duration is stored
 * per stream and rounds; anything larger is a real disagreement between the plan and the
 * picture.
 *
 * ── Why the imports are dynamic ──────────────────────────────────────────────
 *
 * `@remotion/bundler` and `@remotion/renderer` pull in Chromium and esbuild. This module is
 * reachable from the type graph of things Vercel builds, and a static import would put both
 * in a bundle that must never contain them (rule 3). Loaded at call time, in the worker.
 */

export interface RenderInput {
  plan: CompositionPlan;
  /** **http(s) only** — presigned GETs in production. Refused below if not; see why. */
  clipUrls: string[];
  /** Frames per clip. Must sum to the plan's `durationInFrames` — asserted below. */
  clipFrames: number[];
  outputPath: string;
  /** Overrides Remotion's own Chromium. The container has one at /opt/pw-browsers. */
  browserExecutable?: string;
  onProgress?: (rendered: number, total: number) => void;
}

export type RenderResult =
  | { ok: true; outputPath: string; frames: number; durationS: number; expectedS: number }
  | { ok: false; code: string; detail: string };

export async function renderComposition(input: RenderInput): Promise<RenderResult> {
  const { plan, clipUrls, clipFrames, outputPath } = input;
  const expectedS = plan.durationInFrames / plan.fps;

  // ── Refuse before Chromium starts ──────────────────────────────────────────
  //
  // Every one of these is cheap and every one of them, missed, costs a render. A composition
  // whose clip frames do not sum to its own duration is the exact shape of the three bugs
  // above: it renders, it plays, and it is wrong.
  if (clipUrls.length === 0) {
    return { ok: false, code: 'no_clips', detail: 'Nothing to render — the clip list is empty.' };
  }

  if (clipUrls.length !== clipFrames.length) {
    return {
      ok: false,
      code: 'clip_frame_mismatch',
      detail: `${clipUrls.length} clips and ${clipFrames.length} frame counts. One per clip.`,
    };
  }

  // Clips must be **http(s)**, and this is worth refusing on rather than discovering deep in
  // the compositor. A bare path resolves against the bundle's own dev server and 404s for a
  // file that is on disk; a `file://` URL is rejected outright by the asset downloader. Both
  // failures name a stack inside node_modules and neither names the fix.
  //
  // The constraint is right for production and only awkward for a harness: the worker hands
  // over presigned GETs from the bucket, which is the same door the browser uses. A local
  // fixture has to be served over HTTP, which `verify:assemble` does.
  const notHttp = clipUrls.filter((u) => !/^https?:\/\//i.test(u));
  if (notHttp.length > 0) {
    return {
      ok: false,
      code: 'clip_url_not_http',
      detail:
        `${notHttp.length} clip URL(s) are not http(s) — e.g. "${notHttp[0]}". Remotion's `
        + 'asset downloader accepts only http:// and https://; a filesystem path or a file:// '
        + 'URL fails inside the compositor with a message that names neither. Presign them.',
    };
  }

  const summed = clipFrames.reduce((n, f) => n + f, 0);
  if (summed !== plan.durationInFrames) {
    return {
      ok: false,
      code: 'duration_disagreement',
      detail:
        `The clips sum to ${summed} frames and the plan says ${plan.durationInFrames}. `
        + 'Refusing rather than rendering the shorter of the two: a file of the wrong length '
        + 'still plays, so nothing downstream would catch this.',
    };
  }

  // A plan that reports problems is still renderable — an unverified safe area is a known
  // limitation, not a fault — so this does not refuse on `plan.problems`. The caller decides,
  // and `verify:assemble` asserts that the problems reach it.

  const { bundle } = await import('@remotion/bundler');
  const { renderMedia, selectComposition } = await import('@remotion/renderer');

  // Resolved from the repo root rather than from `import.meta.url`: this file is compiled
  // under a module setting that forbids the latter, and the worker runs with the repo as its
  // working directory. `entryPoint` is a path string, which is also why nothing under
  // `src/app/` or `src/lib/` ever imports the Remotion entry — there is no import to find.
  const serveUrl = await bundle({
    entryPoint: join(process.cwd(), 'src/remotion/index.ts'),
  });

  const inputProps = { plan, clipUrls, clipFrames };

  const composition = await selectComposition({
    serveUrl,
    id: 'kiln-video',
    inputProps,
    browserExecutable: input.browserExecutable,
  });

  await renderMedia({
    composition: {
      ...composition,
      // The registered composition carries placeholders. Every dimension that matters comes
      // from the plan, because one composition serves three formats and only the plan knows
      // which one this is.
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      durationInFrames: plan.durationInFrames,
    },
    serveUrl,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
    browserExecutable: input.browserExecutable,
    onProgress: ({ renderedFrames }) => input.onProgress?.(renderedFrames, plan.durationInFrames),
  });

  // ── Measure what was produced ──────────────────────────────────────────────
  //
  // FRAMES, not seconds, and the difference is not pedantry — it is this project's rule
  // about which instrument can observe the thing, caught on the first real render.
  //
  // The first version compared `format=duration` against `durationInFrames / fps` and failed
  // a correct render: 4.053s against a planned 4.000s. The video stream was exactly 120
  // packets and exactly 4.000000s. The extra 53ms is the *container* envelope, which spans
  // the audio stream too, and AAC frames do not align with video frames. Loosening the
  // tolerance would have made a wrong measurement pass instead of taking the right one.
  //
  // A plan specifies an integer number of video frames, so the assertion is exact and needs
  // no tolerance at all.
  const rendered = await probeVideoFrames(outputPath);

  if (rendered === null) {
    return {
      ok: false,
      code: 'unmeasurable_output',
      detail:
        `ffprobe could not count video frames in ${outputPath}. The file exists and its length `
        + 'is unknown, which is not the same as zero — refusing rather than passing on a '
        + 'measurement nobody took.',
    };
  }

  if (rendered !== plan.durationInFrames) {
    return {
      ok: false,
      code: 'wrong_duration',
      detail:
        `Rendered ${rendered} video frames against a planned ${plan.durationInFrames} `
        + `(${(rendered / plan.fps).toFixed(3)}s against ${expectedS.toFixed(3)}s at `
        + `${plan.fps}fps). The file plays and is wrong, which is why this is measured here `
        + 'rather than trusted.',
    };
  }

  return { ok: true, outputPath, frames: rendered, durationS: rendered / plan.fps, expectedS };
}

/**
 * Video-stream packet count. Null when unreadable — never `?? 0`.
 *
 * A zero here would flow into the comparison above as a real measurement and report a
 * duration disagreement for a file whose frames were simply never counted. `probe()` in the
 * ingest path had exactly that bug, and it re-encoded a file whose properties were unknown.
 *
 * `-count_packets` on the video stream rather than `format=duration`: the container's
 * duration spans every stream, so an audio track that does not end on a video-frame boundary
 * makes a correct render look 53ms long. Ask the stream that the plan is about.
 */
async function probeVideoFrames(path: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-count_packets',
      '-show_entries', 'stream=nb_read_packets',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ]);
    const n = Number(stdout.trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
