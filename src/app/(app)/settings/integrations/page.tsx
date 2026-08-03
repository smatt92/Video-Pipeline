import { IntegrationCard } from '@/components/settings/integration-card';
import { SectionHeader } from '@/components/settings/parts';
import { allIntegrationViews, type StepIntegrationView } from '@/lib/onboarding/step-view';

/**
 * Integrations.
 *
 * Real state, read from the database: which credentials are configured (last four only),
 * when each was last checked, whether it passed, and what the last failure said. The
 * fixtures this screen used to render are gone — a settings page that looks authoritative
 * while displaying fabricated verification is precisely the thing verification exists to
 * prevent.
 *
 * Per-request, never cached. A page that renders a stale "verified" over a credential that
 * stopped working an hour ago is worse than one that is slow.
 */

export const dynamic = 'force-dynamic';

/**
 * Dependency blocking, resolved against real verification state.
 *
 * The descriptor names a slug it depends on; this asks whether that one actually verified,
 * rather than whether it exists. Storage before anything that writes: a video credential
 * that "passes" before storage works has proven nothing, because the clip generates,
 * cannot be written anywhere, and you have paid for it.
 */
function blockingDependency(
  view: StepIntegrationView,
  all: StepIntegrationView[],
): string | null {
  const dependsOn = view.descriptor.dependsOn;
  if (!dependsOn) return null;

  const dependency = all.find((v) => v.slug === dependsOn);
  if (!dependency) return null;

  return dependency.state === 'verified' ? null : dependency.label;
}

export default async function IntegrationsPage() {
  const views = await allIntegrationViews();

  // Computed once on the server. A client-side `new Date()` would disagree with the
  // generated `expires_at` across a timezone boundary and mark a live tranche lapsed.
  const today = new Date().toISOString().slice(0, 10);

  const unverified = views.filter((v) => v.state !== 'verified');

  return (
    <>
      <SectionHeader
        title="Integrations"
        hint="Credentials live in Vault. Fields are write-only — a secret is never returned to the browser, only its last four characters."
      />

      {unverified.length > 0 && (
        <div
          className="mb-5 rounded-sm border px-3 py-2 text-xs leading-relaxed"
          style={{
            borderColor: 'var(--border-strong)',
            background: 'var(--surface-inset)',
            color: 'var(--text-muted)',
          }}
        >
          {unverified.length} of {views.length} integrations {unverified.length === 1 ? 'is' : 'are'}{' '}
          unverified. A pipeline task refuses to select one that has never passed a real
          call — enabling is a statement of intent, verifying is a statement of fact.
        </div>
      )}

      {views.map((v) => (
        <IntegrationCard
          key={v.slug}
          view={v}
          blockedBy={blockingDependency(v, views)}
          today={today}
        />
      ))}
    </>
  );
}
