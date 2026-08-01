/**
 * Which build this is.
 *
 * Rendered on `/login` because that is the page you are looking at when you suspect a
 * deployment did not take. Three debugging sessions have been spent on a stale deployment
 * mistaken for a code bug; a visible sha turns that from an inference into a comparison
 * against `git log`.
 *
 * Read from two places on purpose. `VERCEL_GIT_COMMIT_SHA` is populated at runtime on the
 * platform and is authoritative there — it survives an env-var change that triggers a
 * rebuild. `KILN_BUILD_SHA` is inlined by `next.config.ts` at build time and covers local
 * builds, where there is no platform to ask. Runtime wins where both exist, because a
 * runtime value cannot be stale by construction and a build-time one can.
 */
export interface BuildInfo {
  sha: string;
  builtAt: string | null;
  branch: string | null;
  /** Whether the sha came from the platform at runtime or was baked in at build. */
  source: 'runtime' | 'build';
}

export function buildInfo(): BuildInfo {
  const runtime = process.env.VERCEL_GIT_COMMIT_SHA;

  return {
    sha: (runtime ?? process.env.KILN_BUILD_SHA ?? 'unknown').slice(0, 8),
    builtAt: process.env.KILN_BUILD_AT ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    source: runtime ? 'runtime' : 'build',
  };
}
