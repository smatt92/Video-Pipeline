import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { probeVideoFrames } from '../assemble/render';
import type { BureauLayer, BureauVideoProps } from '../../remotion/bureau/bureau-video';

/**
 * Render one layer of a Bureau episode on the Remotion worker (@remotion/renderer, the
 * existing Trigger worker image with chrome-headless-shell).
 *
 *   composite / clean_master  H.264 MP4, with the VO
 *   caption_layer             ProRes 4444 with alpha, text only — laid over the master in an
 *                             editor or used to burn a language's captions without re-rendering
 *                             the picture
 *
 * The frame count is MEASURED from the output's video stream and compared exactly against the
 * plan (CLAUDE.md: a file of the wrong length plays and is wrong).
 */

export interface BureauRenderInput {
  props: BureauVideoProps;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  outputPath: string;
  browserExecutable?: string;
  /** Reuse one webpack bundle across the three layers of an episode. */
  serveUrl?: string;
  onProgress?: (done: number, total: number) => void;
}

export type BureauRenderResult =
  | { ok: true; outputPath: string; frames: number; layer: BureauLayer; serveUrl: string }
  | { ok: false; code: string; detail: string };

/**
 * The Remotion site to render from. On the worker it is prebuilt by `pnpm remotion:bundle` in
 * CI and shipped into the image (trigger.config.ts → additionalFiles): bundling at render time
 * inside an esbuild-bundled worker is what failed S001 on 07-Oct. With no prebuilt site —
 * a developer machine, a harness — it bundles on the fly as before.
 */
export async function bundleRemotion(): Promise<string> {
  const prebuilt = join(process.cwd(), 'remotion-bundle');
  if (existsSync(join(prebuilt, 'index.html'))) return prebuilt;
  const { bundle } = await import('@remotion/bundler');
  return bundle({ entryPoint: join(process.cwd(), 'src/remotion/index.ts') });
}

export async function renderBureau(input: BureauRenderInput): Promise<BureauRenderResult> {
  const total = input.props.shots.reduce((n, s) => n + s.frames, 0);
  if (input.props.layer !== 'caption_layer' && total !== input.durationInFrames) {
    return { ok: false, code: 'duration_disagreement', detail: `shots sum to ${total} frames, the plan says ${input.durationInFrames}` };
  }
  const bad = input.props.shots.filter((s) => s.type === 'clip' && !/^https?:\/\//.test(s.url));
  if (bad.length) return { ok: false, code: 'clip_url_not_http', detail: `${bad.length} clip URL(s) are not http(s); presign them` };

  const { renderMedia, selectComposition } = await import('@remotion/renderer');
  const serveUrl = input.serveUrl ?? (await bundleRemotion());
  const inputProps = input.props as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: 'bureau-video', inputProps, browserExecutable: input.browserExecutable });
  const alpha = input.props.layer === 'caption_layer';

  await renderMedia({
    composition: { ...composition, width: input.width, height: input.height, fps: input.fps, durationInFrames: input.durationInFrames },
    serveUrl,
    inputProps,
    outputLocation: input.outputPath,
    browserExecutable: input.browserExecutable,
    ...(alpha
      ? // VP9 WebM with alpha, not ProRes 4444. ProRes at 1080×1920 is ~330 Mbit/s — S001's 51 s
        // caption layer was ~2 GB, rendered in 8 min and then sat uploading past any storage
        // object limit (07-Oct). A transparent caption layer is mostly empty pixels; VP9 alpha
        // carries it in a few MB, and editors and ffmpeg overlay it the same way.
        { codec: 'vp9' as const, imageFormat: 'png' as const, pixelFormat: 'yuva420p' as const, muted: true }
      : { codec: 'h264' as const }),
    onProgress: ({ renderedFrames }) => input.onProgress?.(renderedFrames, input.durationInFrames),
  });

  const frames = await probeVideoFrames(input.outputPath);
  if (frames === null) return { ok: false, code: 'unmeasurable_output', detail: `could not count frames in ${input.outputPath}` };
  if (frames !== input.durationInFrames) {
    return { ok: false, code: 'wrong_duration', detail: `rendered ${frames} frames against a planned ${input.durationInFrames}` };
  }
  return { ok: true, outputPath: input.outputPath, frames, layer: input.props.layer, serveUrl };
}
