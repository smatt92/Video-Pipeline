import { SIGN_IN_REFUSED } from "@/lib/auth/allowed";
import { probeProviders } from "@/lib/auth/providers";
import { buildInfo } from "@/lib/build-info";
import { parseAllowlist } from "@/lib/auth/config";

import { SignInForm } from "./sign-in-form";

/**
 * Sign in.
 *
 * The only route in the product reachable without a session, and it holds nothing — no
 * workspace name, no vendor list, no hint about which address is the permitted one. A
 * preview deployment is a public URL, and this is the page a stranger sees.
 */

// Per-request: the allowlist warning below reads the environment at request time, and a
// prerendered copy would keep saying "configured" after the variable was fixed.
export const dynamic = "force-dynamic";

export const metadata = { title: "Kiln — sign in" };

const DENIALS: Record<string, string> = {
  not_allowed: SIGN_IN_REFUSED,
  unconfigured: SIGN_IN_REFUSED,
  no_code: "That sign-in link was incomplete. Request a new one.",
  exchange_failed:
    "That sign-in link has expired or was already used. Request a new one.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; denied?: string }>;
}) {
  const { next, denied } = await searchParams;
  const safeNext = next?.startsWith("/") && !next.startsWith("//") ? next : "/";
  const message = denied ? (DENIALS[denied] ?? DENIALS.not_allowed) : null;

  /**
   * Malformed allowlist entries, surfaced here specifically.
   *
   * A typo alongside one good address does not trigger the misconfiguration 503 — the gate
   * is configured, it just quietly does not include you. That failure is invisible by
   * construction: you request a link, nothing arrives, and there is no way to tell a
   * dropped entry from a mail delay. This is the screen where someone discovers they
   * cannot sign in, so it is the screen that should say why.
   *
   * Addresses, not secrets. Naming them is the point.
   */
  const { malformed } = parseAllowlist(process.env.ALLOWED_EMAIL ?? null);

  const providers = await probeProviders();
  const build = buildInfo();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[400px] flex-col justify-center px-6 py-12">
      <div className="mb-7 flex items-center gap-2">
        <span
          aria-hidden
          className="size-[7px] rounded-full"
          style={{ background: "var(--brand-mark)" }}
        />
        <span className="text-sm font-medium tracking-tight">Kiln</span>
      </div>

      <h1 className="mb-2 text-xl font-medium tracking-tight">Sign in</h1>
      <p
        className="mb-6 text-sm leading-relaxed"
        style={{ color: "var(--text-secondary)" }}
      >
        Single-tenant. One address is permitted, set at deploy time.
      </p>

      {message && (
        <div
          className="mb-5 rounded-sm border px-3 py-2 text-xs leading-relaxed"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-inset)",
            color: "var(--text-muted)",
          }}
        >
          {message}
        </div>
      )}

      <SignInForm
        next={safeNext}
        googleState={providers.google}
        googleDetail={providers.detail}
      />

      {/* The build marker.
          Three debugging sessions have gone on a stale deployment mistaken for a code bug.
          A visible sha turns "is my change live?" from an inference into a comparison
          against git log — and `source` says whether the platform reported it at runtime or
          it was baked in, because a build-time value can itself be stale. */}
      <p
        className="mt-8 font-mono text-2xs"
        style={{ color: "var(--text-faint)" }}
        data-build-sha={build.sha}
      >
        build {build.sha}
        {build.branch ? ` · ${build.branch}` : ""}
        {build.source === "build" ? " · baked in at build" : ""}
        {build.builtAt
          ? ` · ${build.builtAt.slice(0, 16).replace("T", " ")}`
          : ""}
      </p>

      {malformed.length > 0 && (
        <div
          className="mt-6 rounded-sm border px-3 py-2 text-xs leading-relaxed"
          style={{
            borderColor: "var(--border-strong)",
            background: "var(--surface-inset)",
            color: "var(--state-review)",
          }}
        >
          <strong className="font-medium">
            {`ALLOWED_EMAIL has ${malformed.length} unusable ${malformed.length === 1 ? "entry" : "entries"}`}
          </strong>
          , ignored by the allowlist:{" "}
          {malformed.map((e) => (
            <code key={e} className="font-mono">
              {e}
            </code>
          ))}
          . A missing <code className="font-mono">.com</code> is the usual
          cause. Anyone at those addresses will request a link and never receive
          one.
        </div>
      )}
    </div>
  );
}
