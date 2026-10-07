import { environmentFields } from '@/lib/integrations/credentials';
import { hasVerified } from '@/lib/integrations/state';
import type { StepIntegrationView } from '@/lib/onboarding/step-view';

import { IntegrationStepForm } from './step-forms';

/**
 * One integration on a setup page (canvas: Onb-Studio / Onb-Models / Onb-Generation).
 *
 * Each key is shown as one of three things, never its value: found in this deployment's
 * environment (name only — decision 0017: the environment is not this app's to display, so
 * not even its last four), stored in Vault (last four only), or missing. "Save and test" is
 * the existing step check; typing nothing tests whatever is configured.
 */

function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
}

export function stateOf(view: StepIntegrationView): { tone: 'live' | 'blk' | 'rev'; text: string } {
  if (view.state === 'failed') return { tone: 'blk', text: hasVerified({ last_verified_at: view.lastVerifiedAt }) ? 'failed last test' : 'failed' };
  if (hasVerified({ last_verified_at: view.lastVerifiedAt }) && view.state === 'verified') return { tone: 'live', text: 'verified' };
  return { tone: 'rev', text: 'not verified' };
}

export function EnvRows({ view, optional }: { view: StepIntegrationView; optional?: boolean }) {
  const inEnv = new Set(environmentFields(view.descriptor.secretFields));
  const vault = new Map(view.secrets.map((s) => [s.fieldKey, s]));
  return (
    <div className="col" style={{ gap: 8 }}>
      {view.descriptor.secretFields.map((f) => {
        const v = vault.get(f.key);
        const env = inEnv.has(f.key);
        const found = !!v || env;
        return (
          <div className={`env${found ? '' : optional ? ' opt' : ' miss'}`} key={f.key}>
            <span className="envdot" aria-hidden="true" />
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <span className="var" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {f.key}
              </span>
              <span className="sub">
                {v ? (
                  <>
                    stored in Vault · <span className="sec">••••{v.last4}</span>
                  </>
                ) : env ? (
                  'found in environment'
                ) : (
                  optional ? 'not set — add it where you host Kiln when you want it' : 'missing — add it where you host Kiln, then test'
                )}
                {view.lastVerifiedAt && found ? ` · tested ${when(view.lastVerifiedAt)}` : ''}
              </span>
            </div>
            {v ? <span className="lock">last 4 only</span> : env ? <span className="xs t3">name only</span> : optional ? <span className="xs t3">not set</span> : <span className="xs" style={{ color: 'var(--blk-text)' }}>blocks step</span>}
          </div>
        );
      })}
    </div>
  );
}

export function IntegrationSection({
  title,
  sub,
  view,
  stepNumber,
  verification,
  fieldsHidden,
  locked,
}: {
  title: string;
  sub: string;
  view: StepIntegrationView | null;
  stepNumber: number;
  verification: string;
  fieldsHidden?: boolean;
  /** The step's blockers are not done: say which, draw no form. */
  locked?: string | null;
}) {
  if (!view) {
    return (
      <section className="card card-b col" style={{ gap: 10 }}>
        <span className="h3">{title}</span>
        <div className="em">
          <span>This step configures no integration in this build.</span>
        </div>
      </section>
    );
  }
  const st = stateOf(view);
  return (
    <section className="card card-b col" style={{ gap: 14, borderColor: st.tone === 'blk' ? 'var(--blk-line)' : undefined }}>
      <div className="row sb">
        <div className="col" style={{ gap: 2 }}>
          <h2 className="h3">{title}</h2>
          <span className="xs t3">{sub}</span>
        </div>
        <span className={`pill s-${st.tone}`}>{st.text}</span>
      </div>
      <EnvRows view={view} />
      {view.state === 'failed' && view.lastError && (
        <div className="blocker">
          <span aria-hidden="true" className="tblk">
            !
          </span>
          <p>
            {view.lastError} <span>Fix it where the key lives, then test again.</span>
          </p>
        </div>
      )}
      {locked ? (
        <div className="em">
          <span>Locked until {locked} passes — testing this first would prove nothing.</span>
        </div>
      ) : (
        <details open={!fieldsHidden && view.state !== 'verified'}>
          <summary className="sm t2" style={{ cursor: 'pointer', minHeight: 32, display: 'flex', alignItems: 'center' }}>
            {view.state === 'verified' ? 'Test again, or replace a key' : 'Save and test'}
          </summary>
          <div style={{ marginTop: 12 }}>
            <IntegrationStepForm stepNumber={stepNumber} view={view} verification={verification} fieldsHidden={fieldsHidden} label={view.state === 'verified' ? 'Test again' : 'Save and test'} />
          </div>
        </details>
      )}
    </section>
  );
}
