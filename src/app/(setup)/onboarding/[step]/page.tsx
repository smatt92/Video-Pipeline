import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  ChannelForm,
  IntegrationStepForm,
  ProfileForm,
  RateCardForm,
} from '@/components/onboarding/step-forms';
import { CheckPill } from '@/components/settings/parts';
import { onboardingProgress } from '@/lib/onboarding/progress';
import { stepIntegrationView } from '@/lib/onboarding/step-view';
import { STEPS, isUnlocked, stepBySlug } from '@/lib/onboarding/steps';

/** Relative time, coarse on purpose — the exact second helps nobody here. */
function when(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * The wizard.
 *
 * Progress is read from `profiles.onboarding_step` — the same column middleware gates on,
 * so the tick marks here and the lock on the rest of the app cannot disagree.
 *
 * What the page must not do is *look* verified. The per-step results below are still
 * "never run": the column records how far the wizard got, and the individual vendor
 * probes that would fill in each result do not exist yet.
 */

// Per-user by definition: the tick marks come from this user's profile row. There is no
// version of this page that can be prerendered and still be true.
export const dynamic = 'force-dynamic';

export default async function OnboardingStepPage({
  params,
}: {
  params: Promise<{ step: string }>;
}) {
  const { step: slug } = await params;
  const step = stepBySlug(slug);
  if (!step) notFound();

  const progress = await onboardingProgress();
  const completed = progress.completed;
  const done = completed.includes(step.n);

  // Null for steps that configure no vendor — 1, 6, 8, 9 and 10.
  const view = await stepIntegrationView(step.n);

  const unlocked = isUnlocked(step, completed);
  const blockers = step.blockedBy
    .filter((n) => !completed.includes(n))
    .map((n) => STEPS.find((s) => s.n === n)!.title);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[880px] flex-col px-6 py-8">
      {/* ── Progress rail ────────────────────────────────────────────────── */}
      <div className="mb-8 flex items-center gap-2">
        <span
          aria-hidden
          className="size-[7px] rounded-full"
          style={{ background: 'var(--brand-mark)' }}
        />
        <span className="text-[13px] font-medium tracking-tight">Kiln — first run</span>
        <span className="ml-auto font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
          {completed.length} of {STEPS.filter((s) => s.required).length} required steps done
        </span>
      </div>

      <ol className="mb-8 flex flex-wrap gap-[6px]">
        {STEPS.map((s) => {
          const done = completed.includes(s.n);
          const here = s.slug === slug;
          const open = isUnlocked(s, completed);
          return (
            <li key={s.n}>
              <Link
                href={`/onboarding/${s.slug}`}
                className="flex items-center gap-2 rounded-sm border px-2 py-[5px] text-[11.5px] transition-colors"
                style={{
                  borderColor: here ? 'var(--accent)' : 'var(--border-subtle)',
                  color: here
                    ? 'var(--text-primary)'
                    : open
                      ? 'var(--text-muted)'
                      : 'var(--text-faint)',
                  background: here ? 'var(--surface-1)' : 'transparent',
                  transitionDuration: 'var(--duration-fast)',
                }}
              >
                <span className="font-mono text-[10px]">{s.n}</span>
                <span>{s.title}</span>
                {done && <span aria-hidden>✓</span>}
                {!open && <span aria-hidden style={{ color: 'var(--text-faint)' }}>·</span>}
              </Link>
            </li>
          );
        })}
      </ol>

      {/* ── The step ─────────────────────────────────────────────────────── */}
      <div className="flex-1">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-[19px] font-medium tracking-tight">{step.title}</h1>
          {!step.required && (
            <span
              className="rounded-xs px-[6px] py-[2px] font-mono text-[10px] uppercase"
              style={{ background: 'var(--surface-2)', color: 'var(--text-faint)' }}
            >
              optional
            </span>
          )}
        </div>

        <p className="mb-6 max-w-[62ch] text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          {step.blurb}
        </p>

        {!unlocked && (
          <div
            className="mb-6 rounded-sm border px-3 py-2 text-[12px]"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--surface-inset)',
              color: 'var(--text-muted)',
            }}
          >
            Locked until {blockers.join(' and ')} {blockers.length === 1 ? 'passes' : 'pass'}.
            The order is not cosmetic — verifying this first would prove nothing.
          </div>
        )}

        {step.stubbed && (
          <div
            className="mb-6 rounded-sm border px-3 py-2 text-[12px] leading-relaxed"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--surface-inset)',
              color: 'var(--text-muted)',
            }}
          >
            {step.stubbed}
          </div>
        )}

        <div
          className="rounded-md border p-4"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="mb-3 flex items-center gap-3">
            <span
              className="font-mono text-[10px] uppercase tracking-[0.09em]"
              style={{ color: 'var(--text-faint)' }}
            >
              What this step verifies
            </span>
            {/* Three states, never two. "never run" and "failed" are different
                instructions to whoever is reading them. */}
            {view && (
              <span className="ml-auto">
                <CheckPill
                  passed={view.state === 'never_run' ? null : view.state === 'verified'}
                  label={
                    view.state === 'never_run'
                      ? 'never run'
                      : view.state === 'verified'
                        ? `verified ${when(view.lastVerifiedAt)}`
                        : `failed ${when(view.lastCheckedAt)}`
                  }
                />
              </span>
            )}
            {done && !view && <span className="ml-auto"><CheckPill passed label="done" /></span>}
          </div>
          <p className="mb-5 max-w-[70ch] text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {step.verification}
          </p>

          {!unlocked || step.stubbed ? (
            <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
              {step.stubbed ? 'Nothing to run yet.' : 'Complete the steps above first.'}
            </p>
          ) : (
            <>
              {step.n === 1 && <ProfileForm email={progress.email} />}
              {step.n === 6 && <RateCardForm />}
              {step.n === 8 && <ChannelForm />}
              {view && (
                <IntegrationStepForm
                  stepNumber={step.n}
                  view={view}
                  verification={step.verification}
                />
              )}
              {step.n === 9 && (
                <p className="text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Deferred. YouTube and Instagram are needed for Phase 3 publishing and
                  nothing before it, and an MCP server is an exploration tool rather than a
                  pipeline dependency.
                </p>
              )}
            </>
          )}

          {view?.lastError && view.state === 'failed' && (
            <p className="mt-4 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Last recorded failure: {view.lastError}
            </p>
          )}
        </div>
      </div>

      {/* ── Footer nav ───────────────────────────────────────────────────── */}
      <div className="mt-8 flex items-center gap-3">
        {step.n > 1 && (
          <Link
            href={`/onboarding/${STEPS[step.n - 2].slug}`}
            className="text-[12.5px] underline underline-offset-4"
            style={{ color: 'var(--text-muted)' }}
          >
            ← {STEPS[step.n - 2].title}
          </Link>
        )}
        {step.n < STEPS.length && (
          <Link
            href={`/onboarding/${STEPS[step.n].slug}`}
            className="ml-auto text-[12.5px] underline underline-offset-4"
            style={{ color: 'var(--accent)' }}
          >
            {STEPS[step.n].title} →
          </Link>
        )}
      </div>

      <p className="mt-6 text-[11px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
        {progress.unavailable
          ? `Progress could not be read (${progress.unavailable}), so nothing above is ticked and the app stays locked. That is the gate refusing to guess, not a display bug.`
          : progress.outstanding.length === 0
            ? 'Every required step has passed. The rest of the app is unlocked.'
            : `Read from profiles.onboarding_completed_steps. Middleware redirects every route except /onboarding/*, /settings/* and /login until ${progress.outstanding.length} more required step${progress.outstanding.length === 1 ? '' : 's'} pass — a failed check advances nothing.`}
      </p>
    </div>
  );
}
