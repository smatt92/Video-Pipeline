import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { StorageDriver } from '../storage';

/**
 * Pull stored assets onto local disk so ffmpeg can read them.
 *
 * The leg between "works locally" and "works on Trigger", and the one that fails only
 * after a generation has been paid for.
 *
 * ffmpeg reads files. The concat demuxer reads a list of paths. Neither takes a URL for
 * anything the local driver made unnecessary — with `local-fs` the object already *is* a
 * file, so `07-assemble` could resolve a path directly and the whole download never
 * existed. Against a real bucket it must, and a path that has never run is exactly the
 * category this project keeps refusing to ship.
 *
 * ── Presigned GET, not a privileged read ────────────────────────────────────
 *
 * The download goes through `presignGet` and a plain `fetch`, which is the same mechanism
 * the browser uses. A worker with the service key could read the object directly through
 * the SDK and that would be simpler — and it would mean the presign path could be broken
 * for weeks while every worker kept working, discovered the first time somebody opened a
 * review screen. Using the same door keeps them honest about each other.
 *
 * ── Cleanup on both paths ───────────────────────────────────────────────────
 *
 * `materialise` owns a directory and returns a `release()` that removes it. Every caller
 * runs that in a `finally`, so a refusal mid-assembly leaves no more behind than a
 * success does. A container that leaks a 40 MB temp directory per failed render fills its
 * disk in an afternoon, and the symptom is unrelated tasks failing on ENOSPC.
 */

export interface MaterialisedClip {
  path: string;
  label: string;
  key: string;
  bytes: number;
}

export interface Materialised {
  clips: MaterialisedClip[];
  dir: string;
  /** Idempotent. Safe to call after a partial failure. */
  release: () => Promise<void>;
}

export class MaterialiseError extends Error {
  readonly key: string;
  constructor(key: string, message: string) {
    super(message);
    this.name = 'MaterialiseError';
    this.key = key;
  }
}

export async function materialise(params: {
  driver: StorageDriver;
  dir: string;
  items: { key: string; label: string }[];
  fetchImpl?: typeof fetch;
}): Promise<Materialised> {
  const { driver, dir, items } = params;
  const doFetch = params.fetchImpl ?? fetch;

  await mkdir(dir, { recursive: true });

  const release = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  const clips: MaterialisedClip[] = [];

  try {
    for (const [i, item] of items.entries()) {
      // Numbered rather than named from the key: a key ends in `video.mp4` for every
      // generation, so the basenames would collide and each clip would overwrite the last.
      // The concat list would then be six identical paths and the rough cut would be the
      // same shot six times — which plays, and is wrong, which is the failure mode this
      // whole area keeps producing.
      const path = join(dir, `${String(i).padStart(3, '0')}.mp4`);

      const signed = await driver.presignGet({ key: item.key, expiresIn: 900 });

      let response: Response;
      try {
        response = await doFetch(signed.url);
      } catch (err) {
        throw new MaterialiseError(
          item.key,
          `${item.label}: fetch threw — ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!response.ok || !response.body) {
        throw new MaterialiseError(
          item.key,
          `${item.label}: presigned GET returned ${response.status}. The object is absent, or ` +
            'the signature was rejected — a 403 here usually means the clock skew between ' +
            'this container and the signer exceeds the signature window.',
        );
      }

      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(path));

      const { size } = await stat(path);
      if (size === 0) {
        throw new MaterialiseError(item.key, `${item.label}: downloaded zero bytes.`);
      }

      clips.push({ path, label: item.label, key: item.key, bytes: size });
    }

    return { clips, dir, release };
  } catch (err) {
    // Partial downloads are removed before rethrowing. The caller's `finally` would also
    // clean up, but a caller that forgets is a disk that fills, and this is the function
    // that knows the directory exists.
    await release();
    throw err;
  }
}
