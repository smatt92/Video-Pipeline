import {
  CheckPill,
  Mono,
  NotSet,
  Panel,
  Row,
  SectionHeader,
  UnverifiedBanner,
} from '@/components/settings/parts';
import { Hint } from '@/components/shell/hint';
import { PLAN_TIERS } from '@/lib/drivers/catalog';
import { INTEGRATIONS, blockingDependency, type IntegrationView } from '@/lib/fixtures/settings';

/**
 * Integrations.
 *
 * This file names no vendor. Every panel below is driven by a descriptor from the driver
 * catalogue and by capability flags on it — `creditBalance`, `planTierConcurrency` —
 * rather than by comparing a slug against a string. That is not cosmetic compliance with
 * the isolation rule: it is what makes adding a driver a catalogue entry instead of an
 * edit to this screen.
 *
 * Three rules hold here, all structural:
 *
 *   1. A secret never comes back to the browser. Fields are write-only — you can replace
 *      a key, never read one. The read path returns last four and a timestamp.
 *   2. Verification is a real vendor call. A well-formed key that cannot write is the
 *      failure this catches, and it only appears on a call.
 *   3. An integration that has never verified cannot be selected by a pipeline task.
 *      A refusal, not a warning.
 */

function IntegrationCard({ view }: { view: IntegrationView }) {
  const { descriptor: d, state } = view;
  const blockedBy = blockingDependency(view);
  const verified = state.lastVerifiedAt !== null;
  const tiers = PLAN_TIERS[d.slug];

  return (
    <Panel className="mb-4">
      <div
        className="flex items-center gap-3 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <span className="text-[13.5px] font-medium">{d.label}</span>
        <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
          {d.kind}
        </span>

        <span className="ml-auto flex items-center gap-3">
          <CheckPill
            passed={verified ? true : null}
            label={verified ? `verified ${state.lastVerifiedAt}` : 'never verified'}
          />
          <button
            type="button"
            disabled={blockedBy !== null}
            className="rounded-sm px-[10px] py-[5px] text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed"
            style={{
              background: blockedBy ? 'var(--surface-2)' : 'var(--accent)',
              color: blockedBy ? 'var(--text-faint)' : 'var(--accent-contrast)',
              transitionDuration: 'var(--duration-fast)',
            }}
          >
            Test connection
          </button>
        </span>
      </div>

      {blockedBy && (
        <div
          className="border-b px-4 py-2 text-[11.5px]"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-faint)' }}
        >
          Blocked until {blockedBy} verifies — nothing can be stored until storage works,
          so verifying this first would prove nothing.
        </div>
      )}

      {d.secretFields.map((f) => (
        <Row key={f.key} label={f.label} help={f.help}>
          <div className="flex items-center gap-3">
            <input
              type="password"
              placeholder={state.last4[f.key] ? '••••••••' : 'not configured'}
              autoComplete="off"
              minLength={f.minLength}
              className="w-[240px] rounded-sm border bg-transparent px-2 py-[5px] font-mono text-[12px] outline-none"
              style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
            />
            {state.last4[f.key] ? <Mono>…{state.last4[f.key]}</Mono> : <NotSet />}
          </div>
        </Row>
      ))}

      <Row
        label="Checks"
        help="Each is a distinct claim. Credentials being accepted says nothing about whether a write succeeds."
      >
        <div className="flex flex-col gap-[6px]">
          {d.checks.map((c) => (
            <Hint key={c.name} content={c.detail}>
              <CheckPill passed={state.checkResults[c.name] ?? null} label={c.label} />
            </Hint>
          ))}
        </div>
      </Row>

      {d.capabilities.creditBalance && (
        <Row
          label="Credit balance"
          help="Credits expire on a rolling clock. That is a cost the ledger cannot see, because nothing is billed at the moment they evaporate."
        >
          <div className="flex items-center gap-4">
            {state.creditBalance === null ? <NotSet /> : <Mono>{state.creditBalance}</Mono>}
            <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
              {state.creditsExpireAt ?? 'expiry unknown until the balance check runs'}
            </span>
          </div>
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
                    color: state.planTier === t.tier ? 'var(--text-primary)' : 'var(--text-muted)',
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
              <li key={n} className="text-[11.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>
                {n}
              </li>
            ))}
          </ul>
        </Row>
      )}
    </Panel>
  );
}

export default function IntegrationsPage() {
  return (
    <>
      <SectionHeader
        title="Integrations"
        hint="Credentials live in Vault. Fields are write-only — a secret is never returned to the browser."
      />
      <UnverifiedBanner what="No credential has been entered and no vendor call has been made." />

      {INTEGRATIONS.map((v) => (
        <IntegrationCard key={v.descriptor.slug} view={v} />
      ))}
    </>
  );
}
