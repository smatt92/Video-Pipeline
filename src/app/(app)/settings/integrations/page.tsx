import { IntegrationCard } from '@/components/settings/integration-card';
import { ReferralPanel } from '@/components/settings/referral-panel';
import { SectionHeader } from '@/components/settings/parts';
import { environmentFields } from '@/lib/integrations/credentials';
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
        hint="A key lives in one of two places: Vault (typed into a field here) or this deployment's environment (Vercel → Settings → Environment Variables). Vault wins when both hold one. Fields are write-only — a secret is never returned to the browser, only its last four characters."
      />

      <div
        className="mb-5 rounded-sm border px-3 py-2 text-xs leading-relaxed"
        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
      >
        Keys kept in Vercel&apos;s environment do not need typing here. Leave the fields empty and press{' '}
        <span className="font-medium">Save and test</span>: with nothing typed it tests the environment key. A
        key being present is still not enough — an integration is used only once its latest test has passed, so
        each one needs that click once, and again whenever its key changes.
      </div>

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
          unverified. Generation, dispatch, voice, dubs and embeddings refuse an integration until its
          latest Save and test has passed — a key in Vault or in the environment is not enough on its own.
          {/* The same predicate decides both this count and those refusals: integrationState
              in src/lib/integrations/state.ts. */}
        </div>
      )}

      {views.map((v) => (
        <IntegrationCard
          key={v.slug}
          view={v}
          blockedBy={blockingDependency(v, views)}
          today={today}
          envFields={environmentFields(v.descriptor.secretFields)}
        />
      ))}

      {/* Beside the links that mint the codes, which is the only place the numbers mean
          anything. Two counts, no derived rate — see the panel for why. */}
      <ReferralPanel />
    </>
  );
}
