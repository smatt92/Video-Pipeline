'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { CheckPill, Mono, NotSet, Panel, Row } from '@/components/settings/parts';
import { Hint } from '@/components/shell/hint';
import { PLAN_TIERS } from '@/lib/drivers/catalog';
import type { StepState } from '@/lib/onboarding/actions';
import { rotateIntegration } from '@/lib/onboarding/actions';
import type { StepIntegrationView } from '@/lib/onboarding/step-view';

/**
 * One integration, with a working Test connection.
 *
 * This file names no vendor. Every panel is driven by a catalogue descriptor and by
 * capability flags on it — `creditBalance`, `planTierConcurrency` — rather than by
 * comparing a slug against a string. Not cosmetic compliance with the isolation rule: it
 * is what makes adding a driver a catalogue entry instead of an edit to this screen.
 *
 * Three rules hold, all structural:
 *
 *   1. A secret never comes back to the browser. The inputs below have no `defaultValue`
 *      and there is no code path that could give them one — the server sends `last_4` and
 *      two timestamps. Blank means "leave it", which is what makes rotating one field of
 *      three possible without retyping the other two.
 *   2. Verification is a real vendor call. A well-formed key that cannot write is the
 *      failure this catches, and it only appears on a call.
 *   3. Three states, never two. "never run" and "failed" are different instructions.
 */

function TestButton({ blocked }: { blocked: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={blocked || pending}
      className="rounded-sm px-[10px] py-[5px] text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed"
      style={{
        background: blocked ? 'var(--surface-2)' : 'var(--accent)',
        color: blocked ? 'var(--text-faint)' : 'var(--accent-contrast)',
        transitionDuration: 'var(--duration-fast)',
      }}
    >
      {pending ? 'Calling…' : 'Save and test'}
    </button>
  );
}

function stateLabel(view: StepIntegrationView): { passed: boolean | null; label: string } {
  switch (view.state) {
    case 'verified':
      return { passed: true, label: 'verified' };
    case 'failed':
      return { passed: false, label: 'failed' };
    default:
      return { passed: null, label: 'never run' };
  }
}

export function IntegrationCard({
  view,
  blockedBy,
}: {
  view: StepIntegrationView;
  blockedBy: string | null;
}) {
  const d = view.descriptor;
  const tiers = PLAN_TIERS[d.slug];
  const [result, action] = useActionState(rotateIntegration.bind(null, d.slug), {
    status: 'idle',
  } as StepState);

  const pill = stateLabel(view);
  const latest = new Map(view.checks.map((c) => [c.name, c]));

  const planTier = typeof view.config.plan_tier === 'string' ? view.config.plan_tier : null;

  return (
    <Panel className="mb-4">
      <form action={action}>
        <div
          className="flex items-center gap-3 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <span className="text-[13.5px] font-medium">{d.label}</span>
          <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
            {d.kind}
          </span>

          <span className="ml-auto flex items-center gap-3">
            <CheckPill passed={pill.passed} label={pill.label} />
            <TestButton blocked={blockedBy !== null} />
          </span>
        </div>

        {blockedBy && (
          <div
            className="border-b px-4 py-2 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-faint)' }}
          >
            Blocked until {blockedBy} verifies — nothing can be stored until storage works,
            so verifying this first would prove nothing. The server enforces this too; the
            disabled button is a courtesy, not the control.
          </div>
        )}

        {d.secretFields.map((f) => {
          const configured = view.secrets.find((s) => s.fieldKey === f.key);
          return (
            <Row key={f.key} label={f.label} help={f.help}>
              <div className="flex items-center gap-3">
                <input
                  name={f.key}
                  type="password"
                  placeholder={configured ? 'configured — blank leaves it' : 'not configured'}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-[240px] rounded-sm border bg-transparent px-2 py-[5px] font-mono text-[12px] outline-none"
                  style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                />
                {configured ? <Mono>…{configured.last4}</Mono> : <NotSet />}
              </div>
            </Row>
          );
        })}

        <Row
          label="Checks"
          help="Each is a distinct claim. Credentials being accepted says nothing about whether a write succeeds."
        >
          <div className="flex flex-col gap-[6px]">
            {d.checks.map((c) => {
              const seen = latest.get(c.name);
              return (
                <Hint key={c.name} content={seen?.detail || c.detail}>
                  <CheckPill passed={seen ? seen.passed : null} label={c.label} />
                </Hint>
              );
            })}
          </div>
        </Row>

        {result.status !== 'idle' && result.message && (
          <Row label="Last run">
            <p
              className="max-w-[62ch] text-[11.5px] leading-relaxed whitespace-pre-line"
              style={{
                color: result.status === 'ok' ? 'var(--state-live)' : 'var(--state-blocked)',
              }}
            >
              {result.message}
            </p>
          </Row>
        )}

        {view.state === 'failed' && view.lastError && result.status === 'idle' && (
          <Row label="Last failure">
            <p
              className="max-w-[62ch] text-[11.5px] leading-relaxed"
              style={{ color: 'var(--state-blocked)' }}
            >
              {view.lastError}
            </p>
          </Row>
        )}

        {d.capabilities.creditBalance && (
          <Row
            label="Credit balance"
            help="Credits expire on a rolling clock. That is a cost the ledger cannot see, because nothing is billed at the moment they evaporate."
          >
            <p
              className="max-w-[62ch] text-[11.5px] leading-relaxed"
              style={{ color: 'var(--text-faint)' }}
            >
              {latest.get('balance')?.detail ??
                'Not read yet. Run the check to see whether this vendor exposes a balance.'}
            </p>
          </Row>
        )}

        {d.capabilities.planTierConcurrency && tiers && (
          <Row
            label="Plan tier → concurrency"
            help="Read from the account during verification, stored on the integration, and read by the queue at run time."
          >
            <div className="flex flex-wrap gap-[6px]">
              {tiers.map((t) => (
                <Hint key={t.tier} content={t.note || `${t.concurrency} parallel requests`}>
                  <span
                    className="rounded-xs px-[6px] py-[3px] font-mono text-[11px]"
                    style={{
                      background: 'var(--surface-2)',
                      color: planTier === t.tier ? 'var(--text-primary)' : 'var(--text-muted)',
                    }}
                  >
                    {t.tier} · {t.concurrency}
                  </span>
                </Hint>
              ))}
            </div>
          </Row>
        )}

        {d.notes && (
          <Row label="Known behaviour">
            <ul className="flex flex-col gap-1">
              {d.notes.map((n) => (
                <li
                  key={n}
                  className="text-[11.5px] leading-snug"
                  style={{ color: 'var(--text-faint)' }}
                >
                  {n}
                </li>
              ))}
            </ul>
          </Row>
        )}
      </form>
    </Panel>
  );
}
