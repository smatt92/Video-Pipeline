import { execSync } from 'node:child_process';
import type { NextConfig } from 'next';

/**
 * The build marker.
 *
 * Three separate debugging sessions have been spent on a stale deployment mistaken for a
 * code bug, which makes this the cheapest fix available: a page that says which commit it
 * was built from turns "is my change deployed?" from an inference into a comparison.
 *
 * Vercel provides the sha at runtime, so on a deployment nothing here is needed. This
 * exists for local builds, where there is no platform to ask — and having the marker work
 * everywhere is the point, since a marker you only trust in production is one you learn to
 * ignore locally and then ignore everywhere.
 *
 * A commit sha is not a secret. It identifies a build; it reveals nothing about what is in
 * it to anyone without the repository.
 */
function localSha(): string {
  try {
    return execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // No git — a container built from a tarball, most likely. Say so rather than guessing.
    return 'unknown';
  }
}

const nextConfig: NextConfig = {
  env: {
    KILN_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? localSha(),
    KILN_BUILD_AT: new Date().toISOString(),
  },
};

export default nextConfig;
