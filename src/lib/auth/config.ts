/**
 * The three variables the gate cannot decide without.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE "FIXING" THE process.env READS BELOW
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Everything else in this codebase reads configuration through `src/lib/env.ts`, which
 * validates the whole environment behind a Proxy and fails loudly with a complete list of
 * problems. This module deliberately does not, and it looks like an inconsistency someone
 * should tidy up. It is not. Tidying it up produces a gate that decides on `undefined`.
 *
 * Middleware is compiled for the **Edge runtime**. Next inlines `process.env.SOME_NAME`
 * at build time by rewriting that exact member expression — a static substitution. A Proxy
 * over the entire environment is by definition not a static member expression, so
 * `env.ALLOWED_EMAIL` inside middleware is not something the compiler can see, and it
 * reads `undefined` on a deployed build. An allowlist compared against `undefined` admits
 * whoever is asking.
 *
 * So: literal `process.env.X`, always, in anything middleware imports.
 *
 * The dynamic `process.env[name]` fallback underneath the literals is not redundancy for
 * its own sake. The literal is resolved when the bundle is *built*; a variable added in
 * the platform dashboard afterwards is not in that bundle and does not appear until the
 * next deploy. Where the runtime does populate `process.env` — Vercel does for Edge
 * functions — the dynamic read picks up the newer value. Neither read alone covers both
 * cases, and the failure mode of missing one is a deployment that looks configured and is
 * not.
 */

export const REQUIRED_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'ALLOWED_EMAIL',
] as const;

export type RequiredVar = (typeof REQUIRED_VARS)[number];

/** Build-time literals. One entry per name, because only literals get inlined. */
const LITERALS: Record<RequiredVar, string | undefined> = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ALLOWED_EMAIL: process.env.ALLOWED_EMAIL,
};

function read(name: RequiredVar): string | null {
  const literal = LITERALS[name]?.trim();
  if (literal) return literal;

  // Dynamic read. Survives a variable set after this bundle was built, wherever the
  // runtime populates process.env. Returns undefined on runtimes that do not, which is
  // exactly the case the literal above covers.
  const dynamic = process.env[name]?.trim();
  return dynamic ? dynamic : null;
}

export interface AuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  allowedEmail: string;
}

export type AuthConfigResult =
  | { ok: true; config: AuthConfig }
  /** Names only. A misconfiguration report that quotes values is a credential leak with
   *  a helpful tone. */
  | { ok: false; missing: RequiredVar[] };

/**
 * Read the gate's configuration.
 *
 * Returns a result rather than throwing, and that is the whole point of the module.
 * Throwing here crashes middleware, and middleware runs in front of *everything* —
 * including `/login`, which is the only route that could have helped. A deployment in that
 * state has no way in and no way to tell a missing variable from a bug, because both
 * present as the same opaque 500.
 *
 * Fail closed means deny. It does not mean crash.
 */
export function readAuthConfig(): AuthConfigResult {
  const missing = REQUIRED_VARS.filter((name) => read(name) === null);
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    config: {
      supabaseUrl: read('NEXT_PUBLIC_SUPABASE_URL')!,
      supabaseAnonKey: read('NEXT_PUBLIC_SUPABASE_ANON_KEY')!,
      allowedEmail: read('ALLOWED_EMAIL')!,
    },
  };
}
