import Link from 'next/link';
import { IntegrationCard } from '@/components/settings/integration-card';
import { ReferralPanel } from '@/components/settings/referral-panel';
import { CheckPill, SectionHeader } from '@/components/settings/parts';
import { currentChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { channelPolicy } from '@/lib/screens/common';
import { initials } from '@/lib/shell/initials';
import { environmentFields } from '@/lib/integrations/credentials';
import { hasVerified } from '@/lib/integrations/state';
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

  // The banner's claim and the stages' refusal share one predicate (integrations/state.ts).
  const unverified = views.filter((v) => !hasVerified({ last_verified_at: v.lastVerifiedAt }));
  const failedSince = views.filter((v) => hasVerified({ last_verified_at: v.lastVerifiedAt }) && v.state === 'failed');

  // The same predicate the banner and the stages use (integrations/state.ts) — a second
  // reading of "verified" here would let the summary and the refusal disagree.
  const isOk = (v: StepIntegrationView) => hasVerified({ last_verified_at: v.lastVerifiedAt }) && v.state !== 'failed';
  const failed = failedSince.length;
  const never = unverified.length;
  const verified = views.length - failed - never;
  const channel = await currentChannel().then((c) => c.active).catch(() => null);
  const caps = channel ? await channelPolicy(serverClient(), channel.id).catch(() => null) : null;
  const abbr = (label: string) => label.replace(/[^A-Za-z ]/g, '').split(/\s+/).filter(Boolean).map((w, i, a) => (a.length > 1 ? w[0] : w.slice(0, 2))).join('').slice(0, 2);

  return (
    <>
      <div className="split">
        <section className="wide card" aria-label="Integrations">
          <div className="card-h">
            <h2 className="h3">Integrations</h2>
            <div className="row" style={{ gap: 6 }}>
              <span className="pill s-live nodot">{verified} verified</span>
              {failed > 0 && <span className="pill s-blk nodot">{failed} failed</span>}
              {never > 0 && <span className="pill s-rev nodot">{never} never verified</span>}
            </div>
          </div>
          {views.map((v) => {
            const blocked = blockingDependency(v, views);
            return (
              <a className="ig" href={`#${v.slug}`} key={v.slug}>
                <span className="ig-logo" aria-hidden="true">
                  {abbr(v.label)}
                </span>
                <span className="col" style={{ gap: 2, minWidth: 0 }}>
                  <span style={{ fontWeight: 500 }}>{v.label}</span>
                  <span className="xs t3">{blocked ? `Blocked until ${blocked} verifies` : v.descriptor.kind}</span>
                </span>
                <CheckPill
                  passed={isOk(v) ? true : hasVerified({ last_verified_at: v.lastVerifiedAt }) ? false : null}
                  label={isOk(v) ? 'verified' : hasVerified({ last_verified_at: v.lastVerifiedAt }) ? 'failed' : 'never verified'}
                />
                <span className={`btn sm${isOk(v) ? ' ghost' : ''}`}>{isOk(v) ? 'Re-check' : 'Save and test'}</span>
              </a>
            );
          })}
        </section>
        <aside className="side">
          <section className="card" aria-label="Channels">
            <div className="card-h">
              <h2 className="h3">Channels</h2>
              <span className="xs t3">each scoped on its own</span>
            </div>
            <div className="card-b col" style={{ gap: 12 }}>
              {channel ? (
                <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
                  <div className="av" aria-hidden="true">{initials(channel.name)}</div>
                  <div className="col grow" style={{ gap: 0 }}>
                    <span style={{ fontWeight: 500 }}>{channel.name}</span>
                    <span className="mono xs t3">{channel.handle ?? 'no handle'}</span>
                  </div>
                </div>
              ) : (
                <span className="sm t3">No channel yet.</span>
              )}
              <Link className="btn full" href="/setup/basics?new=1">+ Add channel</Link>
              <Link className="btn ghost full" href="/channels">Publish targets per channel</Link>
            </div>
          </section>
          {channel && (
            <section className="card" aria-label="Caps">
              <div className="card-h">
                <h2 className="h3">Caps · {channel.name.split(' ')[0]}</h2>
                <span className="lock">approver only</span>
              </div>
              <div className="card-b col" style={{ gap: 10 }}>
                {caps === null ? (
                  <span className="sm t3">No policy row for this channel — no cap applies, and stages that need one refuse.</span>
                ) : (
                  ([
                    ['Daily', caps.dailyCap],
                    ['Long-form day', caps.longformDayCap],
                    ['Monthly', caps.monthlyCap],
                    ['Per Short', caps.perShortCap],
                  ] as const).map(([k, v]) => (
                    <div className="row sb sm" key={k}>
                      <span className="t2">{k}</span>
                      <span className="mono">{v === null ? '—' : `₹${v.toLocaleString('en-IN')}`}</span>
                    </div>
                  ))
                )}
                <span className="xs t3">Changed through the approver token (caps_set) or Setup → Caps.</span>
              </div>
            </section>
          )}
        </aside>
      </div>

      <SectionHeader
        title="Keys and tests"
        hint="A key lives in one of two places: Vault (typed into a field here) or this deployment's environment (Vercel → Settings → Environment Variables). Vault wins when both hold one. Fields are write-only — a secret is never returned to the browser, only its last four characters."
      />

      <div className="note">
        <span>
          Keys kept in the deployment&apos;s environment do not need typing here. Leave the fields empty and press <b>Save and test</b>: with nothing typed it tests the environment key. A key being present is still
          not enough — an integration is used only once its latest test has passed, so each one needs that click once, and again whenever its key changes.
        </span>
      </div>

      {unverified.length > 0 && (
        <div className="blocker">
          <p>
            {unverified.length} of {views.length} integrations {unverified.length === 1 ? 'has' : 'have'} never verified.{' '}
            <span>
              Generation, dispatch, voice, dubs and embeddings refuse {unverified.length === 1 ? 'it' : 'those'} until Save and test passes once — a key in Vault or in the environment is not enough on its own.
            </span>
          </p>
        </div>
      )}

      {failedSince.length > 0 && (
        <div className="blocker">
          <p>
            {failedSince.map((v) => v.label).join(', ')} verified before and failed {failedSince.length === 1 ? 'its' : 'their'} latest test.{' '}
            <span>
              Tasks still use {failedSince.length === 1 ? 'it' : 'them'} — a failed re-test is as likely a network blip as a dead key — so run Save and test again, and rotate the key if it fails twice.
            </span>
          </p>
        </div>
      )}

      {views.map((v) => (
        <div id={v.slug} key={v.slug} style={{ scrollMarginTop: 16 }}>
          <IntegrationCard view={v} blockedBy={blockingDependency(v, views)} today={today} envFields={environmentFields(v.descriptor.secretFields)} />
        </div>
      ))}

      {/* Beside the links that mint the codes, which is the only place the numbers mean
          anything. Two counts, no derived rate — see the panel for why. */}
      <ReferralPanel />
    </>
  );
}
