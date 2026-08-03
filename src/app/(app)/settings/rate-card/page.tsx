import { Panel, SectionHeader, UnverifiedBanner } from '@/components/settings/parts';
import { RateRow } from '@/components/settings/rate-row';
import { serverClient } from '@/lib/db/server';
import { readRateCard } from '@/lib/cost/rate-card';

/**
 * Rate card — from the database.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Why this was rewritten
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The policy this screen exists to service: an unverified rate produces no rupee figure
 * anywhere in the product, and a submit that cannot be priced refuses to run. Its own
 * previous docstring said "this is where you make it stop being true" — and it rendered
 * `RATE_CARD` from `src/lib/fixtures/settings.ts`, so it could not.
 *
 * It also rendered *identically* against a real database, an empty one and a broken one,
 * which is the property that makes this class of screen hard to notice. There was nothing
 * to see. See STATE.md §8.
 *
 * Blast radius, and why this was the pick: `priceLlmCall` and `requirePricing` refuse on an
 * unverified rate, so stages 2, 3, 5, 6 and 9 all stop. Every rate ships at zero and
 * unverified. This is the single screen standing between a configured install and every
 * stage that costs money.
 *
 * ── Three outcomes, never two ────────────────────────────────────────────────
 *
 * Rows, empty, or broken — the same rule the board follows. A blank rate card that could
 * mean "nothing seeded" or "the query failed" hides the second case behind the first, and
 * the second case means every paid stage is refusing for a reason nobody can see.
 */

export default async function RateCardPage() {
  const result = await readRateCard(serverClient());

  if (!result.ok) {
    return (
      <>
        <SectionHeader
          title="Rate card"
          hint="Per driver, per endpoint, per unit. Costs are read off your own account after a real run — no vendor publishes these."
        />
        <Panel className="p-5">
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            The rate card could not be read.
          </p>
          <p className="mt-2 max-w-[68ch] text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {result.hint}
          </p>
          <p className="mt-2 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
            {result.error}
          </p>
        </Panel>
      </>
    );
  }

  const unverified = result.rows.filter((r) => !r.isVerified).length;

  return (
    <>
      <SectionHeader
        title="Rate card"
        hint="Per driver, per endpoint, per unit. Costs are read off your own account after a real run — no vendor publishes these."
      />

      {unverified > 0 && (
        <UnverifiedBanner
          what={`${unverified} of ${result.rows.length} rates have no verified figure. Every stage that would spend money on them refuses until they do.`}
        />
      )}

      {result.rows.length === 0 ? (
        // Distinct from the error state above, and that distinction is the point of the
        // three-outcome rule: this one is a database that applied its migrations and has
        // no catalogue rows, which `pnpm check:catalog` exists to prevent.
        <Panel className="p-5">
          <p className="text-sm">No rates at all.</p>
          <p className="mt-2 max-w-[68ch] text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            The migrations seed one row per driver, model and unit, so an empty table means
            they ran and the catalogue rows did not land. <code>pnpm check:catalog</code> is
            the check for exactly this.
          </p>
        </Panel>
      ) : (
        <Panel>
          <div
            className="grid gap-3 border-b px-4 py-2 font-mono text-3xs uppercase tracking-[0.09em]"
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

          {result.rows.map((r) => (
            <RateRow key={r.id} row={r} />
          ))}
        </Panel>
      )}

      <p className="mt-4 max-w-[72ch] text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        Cost shows <span className="font-mono">—</span> rather than $0 for the same reason
        the board says <span className="font-mono">unpriced</span>: zero is a claim about
        what something cost, and no such claim can be made yet. Recording a rate adds a row
        effective now and keeps the old one — the ledger snapshots unit cost per generation,
        but rewriting the card would leave a six-month-old figure with no rate behind it,
        which is the audit trail that makes cost-per-video defensible.
      </p>
    </>
  );
}
