/**
 * Onboarding.
 *
 * Known gap: this still renders inside the app shell, so the sidebar is visible during
 * the wizard. It should not be — every destination in that nav is meant to be blocked
 * until setup finishes, and offering navigation you cannot use is how a gate quietly
 * becomes a suggestion.
 *
 * Escaping it needs a top-level route group with its own root layout, which is a
 * restructure of `src/app/`. Deferred rather than done because the middleware gate is
 * currently inert anyway (see src/middleware.ts) — with nothing blocked, a visible
 * sidebar is honest about the state of things. Both land together in 1c.
 */
export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh">{children}</div>;
}
