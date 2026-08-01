/**
 * The delivery format every clip is converted to on ingest.
 *
 * Addendum 02 §3: normalise at ingest, not at stitch. The reason is where the failure
 * lands — a stitch is the worst possible place to discover a clip is 24fps or yuv444,
 * because by then every other clip is in position and the fix is a re-render of the whole
 * timeline rather than one re-download.
 *
 * ** The ffmpeg invocation below has never been executed. ** It runs in a Trigger
 * container, which this environment has no route to. Recorded in 0008.
 */

export const TARGET = {
  codec: 'h264',
  pixelFormat: 'yuv420p',
  width: 1080,
  height: 1920,
  fps: 30,
} as const;

export interface ProbedMedia {
  codec: string | null;
  pixelFormat: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  durationS: number | null;
}

/** Whether a probed file already satisfies the target and can be ingested untouched. */
export function conforms(probe: ProbedMedia): boolean {
  return (
    probe.codec === TARGET.codec &&
    probe.pixelFormat === TARGET.pixelFormat &&
    probe.width === TARGET.width &&
    probe.height === TARGET.height &&
    probe.fps !== null &&
    Math.abs(probe.fps - TARGET.fps) < 0.01
  );
}

/**
 * The conversion arguments.
 *
 * `yuv420p` is not a preference. It is the only pixel format every consumer decoder
 * reliably plays; yuv444 produces a file that looks fine in a desktop player and a black
 * rectangle on a phone, which is discovered after publishing.
 *
 * Scale-then-pad rather than crop: a vendor that delivers 16:9 when asked for 9:16 has
 * misunderstood the request, and cropping would silently discard the sides of a frame
 * somebody composed. Padding keeps the whole image and makes the mistake visible.
 */
export function ffmpegArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-y',
    '-i', inputPath,
    '-vf',
    `scale=${TARGET.width}:${TARGET.height}:force_original_aspect_ratio=decrease,` +
      `pad=${TARGET.width}:${TARGET.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
      `fps=${TARGET.fps}`,
    '-c:v', 'libx264',
    '-pix_fmt', TARGET.pixelFormat,
    '-profile:v', 'high',
    '-preset', 'medium',
    '-crf', '20',
    // Moves the index to the front so the file starts playing before it finishes
    // downloading — which matters for review, where the alternative is waiting for a whole
    // clip to arrive before seeing whether the first second is wrong.
    '-movflags', '+faststart',
    outputPath,
  ];
}

/**
 * yuv420p requires even dimensions. 1080x1920 satisfies it, and this asserts rather than
 * assumes so that a future edit to TARGET fails here instead of producing files that some
 * decoders refuse.
 */
export function assertTargetEncodable(): void {
  if (TARGET.width % 2 !== 0 || TARGET.height % 2 !== 0) {
    throw new Error(
      `TARGET is ${TARGET.width}x${TARGET.height}; yuv420p requires even dimensions in both ` +
        'axes. An odd one encodes on some builds and is refused by others, which surfaces as ' +
        'a clip that plays for you and not for a viewer.',
    );
  }
}
