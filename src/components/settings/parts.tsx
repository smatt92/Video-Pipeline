import { Hint } from '@/components/shell/hint';

/**
 * Shared furniture for the settings screens.
 *
 * `UnverifiedBanner` exists because the alternative is worse than ugly. Every screen
 * below shows state that was never confirmed against a real service, and a settings page
 * that looks authoritative while displaying fabricated verification is precisely the
 * thing the verification step was added to prevent.
 */

export function SectionHeader({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-5 flex items-start gap-4">
      <div className="min-w-0">
        <h2 className="text-lg font-medium tracking-tight">{title}</h2>
        {hint && (
          <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            {hint}
          </p>
        )}
      </div>
      {children && <div className="ml-auto shrink-0">{children}</div>}
    </header>
  );
}

export function Panel({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-md border ${className}`}
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
    >
      {children}
    </div>
  );
}

export function Row({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="grid items-start gap-4 border-b px-4 py-3 last:border-b-0"
      style={{ gridTemplateColumns: 'minmax(0, 280px) minmax(0, 1fr)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {help && (
          <div className="mt-[3px] text-xs leading-snug" style={{ color: 'var(--text-faint)' }}>
            {help}
          </div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * Verification state, rendered honestly.
 *
 * Three states, not two: passed, failed, and **never run**. Collapsing "never run" into
 * "failed" would be a lie in the safe direction, and collapsing it into "passed" would be
 * a lie in the dangerous one. It gets its own treatment.
 */
export function CheckPill({ passed, label }: { passed: boolean | null; label: string }) {
  const token =
    passed === true ? 'var(--state-live)' : passed === false ? 'var(--state-blocked)' : 'var(--text-faint)';
  const glyph = passed === true ? '✓' : passed === false ? '✕' : '–';

  return (
    <span className="inline-flex items-center gap-[6px] text-xs" style={{ color: token }}>
      <span aria-hidden className="font-mono">
        {glyph}
      </span>
      {label}
    </span>
  );
}

export function UnverifiedBanner({ what }: { what: string }) {
  return (
    <div
      className="mb-5 rounded-sm border px-3 py-2 text-xs leading-relaxed"
      style={{
        borderColor: 'var(--border-strong)',
        background: 'var(--surface-inset)',
        color: 'var(--text-muted)',
      }}
    >
      <strong className="font-medium" style={{ color: 'var(--text-secondary)' }}>
        Nothing here has been verified.
      </strong>{' '}
      {what} The build environment has no network route to any vendor — every host is
      refused at the egress policy — so every result below is scripted. Run the real checks
      from your own machine before trusting any of it.
    </div>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
      {children}
    </span>
  );
}

export function NotSet() {
  return (
    <Hint content="Never configured. This is not zero and not a default — nothing has been written here.">
      <span className="font-mono text-xs" style={{ color: 'var(--text-faint)' }}>
        not set
      </span>
    </Hint>
  );
}
