import { Panel, SectionHeader, UnverifiedBanner } from '@/components/settings/parts';
import { Hint } from '@/components/shell/hint';
import { RATE_CARD } from '@/lib/fixtures/settings';

/**
 * Rate card.
 *
 * The policy this screen exists to service: an unverified rate produces no rupee figure
 * anywhere in the product, and a submit that cannot be priced refuses to run. That is
 * already enforced below the UI — this is where you make it stop being true.
 *
 * Every row ships unverified with a cost of zero, which is deliberate. A plausible
 * default would be worse than an obvious blank: it would be believed, summed, and put in
 * a business case.
 */
export default function RateCardPage() {
  const unverified = RATE_CARD.filter((r) => !r.isVerified).length;

  return (
    <>
      <SectionHeader
        title="Rate card"
        hint="Per driver, per endpoint, per unit. Costs are read off your own account after a real run — no vendor publishes these."
      />
      <UnverifiedBanner
        what={`All ${unverified} rates are placeholders seeded during the scaffold.`}
      />

      <Panel>
        <div
          className="grid gap-3 border-b px-4 py-2 font-mono text-[10px] uppercase tracking-[0.09em]"
          style={{
            gridTemplateColumns: '108px minmax(0,1fr) 92px 78px 92px',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-faint)',
            background: 'var(--surface-inset)',
          }}
        >
          <span>Driver</span>
          <span>Model / endpoint</span>
          <span>Unit</span>
          <span className="text-right">Cost</span>
          <span className="text-right">Verified</span>
        </div>

        {RATE_CARD.map((r) => (
          <div
            key={`${r.driverLabel}-${r.model}-${r.endpoint ?? ''}`}
            className="grid items-center gap-3 border-b px-4 py-[10px] last:border-b-0"
            style={{
              gridTemplateColumns: '108px minmax(0,1fr) 92px 78px 92px',
              borderColor: 'var(--border-subtle)',
            }}
          >
            <span className="font-mono text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {r.driverLabel}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12.5px]">{r.model}</span>
              <span
                className="block truncate font-mono text-[10.5px]"
                style={{ color: 'var(--text-faint)' }}
              >
                {r.endpoint ?? 'no endpoint'}
              </span>
            </span>
            <span className="font-mono text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {r.unit}
            </span>
            <span className="text-right font-mono text-[12px]" style={{ color: 'var(--text-faint)' }}>
              —
            </span>
            <span className="text-right">
              <Hint content={r.sourceNote || 'No source recorded'}>
                <span
                  className="rounded-xs px-[6px] py-[2px] font-mono text-[10.5px]"
                  style={{
                    background: 'var(--surface-2)',
                    color: r.isVerified ? 'var(--state-live)' : 'var(--text-faint)',
                  }}
                >
                  {r.isVerified ? 'verified' : 'unverified'}
                </span>
              </Hint>
            </span>
          </div>
        ))}
      </Panel>

      <p className="mt-4 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Cost shows <span className="font-mono">—</span> rather than ₹0 for the same reason
        the board says <span className="font-mono">unpriced</span>: zero is a claim about
        what something cost, and no such claim can be made yet. Replace a rate by adding a
        row with a later effective date — never by editing one, because the ledger
        snapshots unit cost per generation and rewriting history breaks the audit trail
        that makes cost-per-video defensible.
      </p>
    </>
  );
}
