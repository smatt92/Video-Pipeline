import { Panel, Row, SectionHeader } from '@/components/settings/parts';
import { GUARDRAILS } from '@/lib/settings/guardrails';

/**
 * Guardrails.
 *
 * This screen answers one question — which limits are actually on, and at what number — so
 * that answering it does not require grepping. Until this change it answered wrongly: it
 * showed 12 shots against a constraint that enforces 8, and two spend caps that nothing
 * sums. Eight rows looked alike and one was real.
 *
 * So the three outcomes are now visually distinct, and the distinction is the register's,
 * not this file's. A number appears only where a number is enforced. Enforced-but-read-at-
 * run-time gets an em dash and its source. Not enforced gets the words "not enforced" and
 * the reason — never a figure, never zero.
 */
export default function GuardrailsPage() {
  const live = GUARDRAILS.filter((g) => g.kind !== 'none').length;

  return (
    <>
      <SectionHeader
        title="Guardrails"
        hint={`${live} of ${GUARDRAILS.length} are enforced. The rest say so rather than showing a number nothing checks.`}
      />

      <Panel>
        {GUARDRAILS.map((g) => (
          <Row key={g.key} label={g.label} help={g.kind === 'none' ? g.why : g.help}>
            <div className="flex items-baseline gap-3">
              {g.kind === 'none' ? (
                <span className="font-mono text-sm" style={{ color: 'var(--state-killed)' }}>
                  not enforced
                </span>
              ) : g.kind === 'runtime' ? (
                <span className="font-mono text-sm" style={{ color: 'var(--text-faint)' }}>
                  —
                </span>
              ) : (
                <span className="font-mono text-sm">
                  {g.unit === '₹'
                    ? `₹${g.value.toLocaleString('en-IN')}`
                    : `${g.value} ${g.unit}`}
                </span>
              )}
              <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
                {g.kind === 'none' ? 'nothing reads this' : g.site}
              </span>
            </div>
          </Row>
        ))}
      </Panel>
    </>
  );
}
