import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CheckPill } from '@/components/settings/parts';
import { CURRENT_STEP, STEPS, isUnlocked, stepBySlug } from '@/lib/onboarding/steps';

/**
 * The wizard.
 *
 * Walkable now with scripted verification results, so the shape can be judged before the
 * vendor calls exist. What it must not do is *look* verified: every step below shows
 * "never run", and the button that would make a real call says so.
 */

export function generateStaticParams() {
  return STEPS.map((s) => ({ step: s.slug }));
}

const completed: number[] = [];

export default async function OnboardingStepPage({
  params,
}: {
  params: Promise<{ step: string }>;
}) {
  const { step: slug } = await params;
  const step = stepBySlug(slug);
  if (!step) notFound();

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
          <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.09em]" style={{ color: 'var(--text-faint)' }}>
            What this step verifies
          </div>
          <p className="mb-4 max-w-[70ch] text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {step.verification}
          </p>

          <div className="flex items-center gap-4">
            <button
              type="button"
              disabled={!unlocked || Boolean(step.stubbed)}
              className="rounded-sm px-3 py-[7px] text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed"
              style={{
                background: unlocked && !step.stubbed ? 'var(--accent)' : 'var(--surface-2)',
                color: unlocked && !step.stubbed ? 'var(--accent-contrast)' : 'var(--text-faint)',
                transitionDuration: 'var(--duration-fast)',
              }}
            >
              Run check
            </button>
            <CheckPill passed={null} label="never run" />
          </div>
        </div>

        <p className="mt-4 text-[11.5px] leading-relaxed" style={{ color: 'var(--text-faint)' }}>
          No vendor call has been made from this environment — every host is refused at the
          egress policy. Running a check here would report a scripted result, which is why
          nothing on this page claims to have passed.
        </p>
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

      <p className="mt-6 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        Current progress is fixture state (step {CURRENT_STEP}). In 1c this reads
        profiles.onboarding_step and middleware redirects every route except /onboarding/*
        and /settings/* until the required steps pass.
      </p>
    </div>
  );
}
