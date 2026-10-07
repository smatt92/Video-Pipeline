import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The Reels cover still: one JPEG frame of the approved cut at `atS`, stored next to the
 * bundle. Worker only (ffmpeg; rule 3). Never fails the bundle — a refusal comes back as a
 * sentence and the Instagram draft says "pick the frame at N s in the app" instead.
 */
export function coverStillWith(deps: {
  presign(key: string): Promise<string>;
  putBytes(key: string, body: Readable): Promise<number>;
  fetchImpl?: typeof fetch;
}) {
  return async (input: { videoKey: string; atS: number; publicationId: string }): Promise<{ ok: true; key: string } | { ok: false; detail: string }> => {
    const work = await mkdtemp(join(tmpdir(), 'kiln-cover-'));
    try {
      const res = await (deps.fetchImpl ?? fetch)(await deps.presign(input.videoKey));
      if (!res.ok) return { ok: false, detail: `download ${res.status}` };
      const video = join(work, 'cut.mp4');
      await writeFile(video, Buffer.from(await res.arrayBuffer()));
      const jpg = join(work, 'cover.jpg');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', input.atS.toFixed(3), '-i', video, '-frames:v', '1', '-q:v', '2', '-y', jpg]);
      const key = `publish/${input.publicationId}/instagram-cover.jpg`;
      await deps.putBytes(key, createReadStream(jpg));
      return { ok: true, key };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : String(err) };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}
