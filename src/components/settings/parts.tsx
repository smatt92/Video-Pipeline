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
    <header className="row sb" style={{ alignItems: 'flex-start', gap: 16, marginBottom: 4 }}>
      <div className="col" style={{ gap: 4, minWidth: 0, flex: '1 1 320px' }}>
        <h2 className="h2">{title}</h2>
        {hint && <p className="sm t3">{hint}</p>}
      </div>
      {children && <div style={{ flex: 'none' }}>{children}</div>}
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
    <div className={`card ${className}`}>{children}</div>
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
    <div className="srow">
      <div style={{ minWidth: 0 }}>
        <div className="sm" style={{ fontWeight: 500 }}>
          {label}
        </div>
        {help && <div className="xs t3" style={{ marginTop: 3 }}>{help}</div>}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
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
  // Pill = state (round dot). Never-run gets the neutral draft tone, not red and not green.
  const tone = passed === true ? 's-live' : passed === false ? 's-blk' : 's-draft';
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function UnverifiedBanner({ what }: { what: string }) {
  return (
    <div className="note" style={{ marginBottom: 12 }}>
      <strong style={{ fontWeight: 600 }}>Nothing here has been verified.</strong>{' '}
      {what} The build environment has no network route to any vendor — every host is
      refused at the egress policy — so every result below is scripted. Run the real checks
      from your own machine before trusting any of it.
    </div>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span className="mono xs t2">{children}</span>
  );
}

export function NotSet() {
  return (
    <Hint content="Never configured. This is not zero and not a default — nothing has been written here.">
      <span className="mono xs t3">not set</span>
    </Hint>
  );
}
