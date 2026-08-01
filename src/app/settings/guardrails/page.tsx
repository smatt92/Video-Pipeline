import { Panel, Row, SectionHeader, UnverifiedBanner } from '@/components/settings/parts';
import { GUARDRAILS } from '@/lib/fixtures/settings';

/**
 * Guardrails.
 *
 * These enforce rather than warn. Each row names where the check actually happens, so
 * "is this on?" is answerable by reading one column instead of by grepping.
 *
 * Two of them are deliberately null. Concurrency comes from the vendor's plan tier and
 * is unknown until that integration verifies — and an unknown ceiling must not be
 * guessed, because a guess above the real limit produces a permanent failure rate that
 * reads as vendor flakiness rather than as our own misconfiguration.
 */
export default function GuardrailsPage() {
  return (
    <>
      <SectionHeader
        title="Guardrails"
        hint="Enforced, not advisory. Where a limit is unknown it stays null rather than taking a plausible default."
      />
      <UnverifiedBanner what="These values are defaults, not settings anyone has chosen." />

      <Panel>
        {GUARDRAILS.map((g) => (
          <Row key={g.key} label={g.label} help={g.help}>
            <div className="flex items-baseline gap-3">
              {g.value === null ? (
                <span className="font-mono text-[12.5px]" style={{ color: 'var(--text-faint)' }}>
                  unknown
                </span>
              ) : (
                <span className="font-mono text-[12.5px]">
                  {g.unit === '₹' ? `₹${g.value.toLocaleString('en-IN')}` : `${g.value} ${g.unit}`}
                </span>
              )}
              <span className="font-mono text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                {g.enforcedAt}
              </span>
            </div>
          </Row>
        ))}
      </Panel>
    </>
  );
}
