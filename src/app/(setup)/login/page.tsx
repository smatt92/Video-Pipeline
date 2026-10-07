import { SIGN_IN_REFUSED } from "@/lib/auth/allowed";
import { probeProviders } from "@/lib/auth/providers";
import { buildInfo } from "@/lib/build-info";
import { parseAllowlist } from "@/lib/auth/config";

import { KilnObject } from "@/components/ui/kiln-object";
import { Lockup } from "@/components/ui/logo";

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
    <main className="splash bp">
      <KilnObject width={300} />
      <Lockup fontSize={44} />
      <p className="chalk-2">Private studio. One operator.</p>

      {message && (
        <p className="splash-msg err splash-card" role="alert">
          {message}
        </p>
      )}

      <SignInForm next={safeNext} googleState={providers.google} googleDetail={providers.detail} />

      {malformed.length > 0 && (
        <div className="splash-msg warn splash-card">
          <strong>{`ALLOWED_EMAIL has ${malformed.length} unusable ${malformed.length === 1 ? "entry" : "entries"}`}</strong>,
          ignored by the allowlist:{" "}
          {malformed.map((e) => (
            <code key={e} className="mono">
              {e}{" "}
            </code>
          ))}
          — a missing <code className="mono">.com</code> is the usual cause. Anyone at those addresses will request a
          link and never receive one.
        </div>
      )}

      {/* The build marker. A visible sha turns "is my change live?" from an inference into a
          comparison against git log — and `source` says whether the platform reported it at
          runtime or it was baked in, because a build-time value can itself be stale. */}
      <p className="mono xs chalk-3" style={{ position: "absolute", bottom: 20, left: 16, right: 16, textAlign: "center" }} data-build-sha={build.sha}>
        kiln · v2 · build {build.sha}
        {build.branch ? ` · ${build.branch}` : ""}
        {build.source === "build" ? " · baked in at build" : ""}
        {build.builtAt ? ` · ${build.builtAt.slice(0, 16).replace("T", " ")}` : ""}
      </p>
    </main>
  );
}
