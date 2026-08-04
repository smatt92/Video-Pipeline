import { Hint } from '@/components/shell/hint';
import type { CreditPosition, DriverLimit } from '@/lib/pipeline/limits';

/**
 * Limits and the credit clock, on the board.
 *
 * Both blocks exist because they are the two things you hit unexpectedly and then spend an
 * hour diagnosing. Both are also the two most tempting places in this app to render a
 * fabricated number, so each figure here is either observed or says it is not.
 *
 * The rules this file follows, all of them earned elsewhere in the project:
 *
 *   · An unknown ceiling renders as "unknown", never as a guess. A guess above the real one
 *     produces a permanent failure rate that reads as vendor flakiness.
 *   · `default` next to a ceiling means our fallback, not the account's answer. A screen
 *     must never present a fallback as a reading.
 *   · No reset countdown appears anywhere. A concurrency ceiling is not a window; a
 *     countdown beside it would be a fiction, and there is no observable windowed quota.
 *   · Credits show a position, never a balance. Nothing writes `credits_spent`, so
 *     "remaining" is unknown rather than equal to purchased.
 *   · "Never submitted" and "never limited" are different facts and never share a cell.
 */

const box = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-1)',
};

export function LimitsStrip({
  limits,
  credits,
  noPurchases,
}: {
  limits: DriverLimit[];
  credits: CreditPosition[];
  noPurchases: boolean;
}) {
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <LimitsCard limits={limits} />
      <CreditsCard credits={credits} noPurchases={noPurchases} />
    </section>
  );
}

function LimitsCard({ limits }: { limits: DriverLimit[] }) {
  const everLimited = limits.reduce(
    (n, l) => n + l.hitsConcurrency + l.hitsRate + l.hitsCredits,
    0,
  );
  const anySubmits = limits.some((l) => l.hasSubmitted);

  return (
    <div className="rounded-md border" style={box}>
      <header className="flex items-baseline gap-2 border-b px-4 py-2.5" style={box}>
        <h2 className="text-sm font-medium">Vendor limits</h2>
        <Hint content="A concurrency ceiling is not a window, so nothing here counts down. The hit columns are what make this useful: in-flight reads 0 on a workspace that has never generated and would stay 0 for ever.">
          <span className="text-2xs" style={{ color: 'var(--text-faint)' }}>
            {anySubmits ? `${everLimited} refusals across ${limits.length} drivers` : 'nothing submitted yet'}
          </span>
        </Hint>
      </header>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-2xs" style={{ color: 'var(--text-faint)' }}>
            <th className="px-4 py-2 font-normal">Driver</th>
            <th className="px-4 py-2 text-right font-normal">In flight</th>
            <th className="px-4 py-2 text-right font-normal">Ceiling</th>
            <th className="px-4 py-2 text-right font-normal">Queued out</th>
            <th className="px-4 py-2 text-right font-normal">Slowed</th>
            <th className="px-4 py-2 font-normal">Last hit</th>
          </tr>
        </thead>
        <tbody>
          {limits.map((l) => (
            <tr key={l.slug} className="border-t" style={box}>
              <td className="px-4 py-2">
                {l.slug}{' '}
                <span className="text-2xs" style={{ color: 'var(--text-faint)' }}>
                  {l.kind}
                </span>
              </td>

              <td className="px-4 py-2 text-right font-mono">
                {l.hasSubmitted ? l.inFlight : <span style={{ color: 'var(--text-faint)' }}>—</span>}
              </td>

              {/* Unknown, not guessed. `default` is our fallback and says so. */}
              <td className="px-4 py-2 text-right font-mono">
                {l.ceiling === null ? (
                  <span style={{ color: 'var(--text-faint)' }}>unknown</span>
                ) : (
                  <>
                    {l.ceiling}
                    {l.ceilingSource === 'default' && (
                      <span className="ml-1 text-2xs" style={{ color: 'var(--text-faint)' }}>
                        fallback
                      </span>
                    )}
                  </>
                )}
              </td>

              {/*
                Counted apart, because the driver layer treats them apart: a concurrency
                refusal wants a queue and a rate refusal wants backoff, and merging them
                is how a retry storm gets built on top of a ceiling.
              */}
              <td className="px-4 py-2 text-right font-mono">
                {l.hasSubmitted ? (
                  l.hitsConcurrency
                ) : (
                  <span style={{ color: 'var(--text-faint)' }}>—</span>
                )}
              </td>
              <td className="px-4 py-2 text-right font-mono">
                {l.hasSubmitted ? l.hitsRate : <span style={{ color: 'var(--text-faint)' }}>—</span>}
              </td>

              <td className="px-4 py-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
                {l.lastHitAt
                  ? new Date(l.lastHitAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
                  : l.hasSubmitted
                    ? `never, in ${l.submitsTotal} submit${l.submitsTotal === 1 ? '' : 's'}`
                    : 'never submitted'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!anySubmits && (
        <p className="border-t px-4 py-2 text-2xs" style={{ ...box, color: 'var(--text-faint)' }}>
          No generation has been submitted to any driver, so in-flight and the hit counts are
          em dashes rather than zeros — nothing has had the chance to be limited yet. Ceilings
          are read from the account when an integration verifies.
        </p>
      )}
    </div>
  );
}

function CreditsCard({
  credits,
  noPurchases,
}: {
  credits: CreditPosition[];
  noPurchases: boolean;
}) {
  return (
    <div className="rounded-md border" style={box}>
      <header className="flex items-baseline gap-2 border-b px-4 py-2.5" style={box}>
        <h2 className="text-sm font-medium">Credit position</h2>
        <Hint content="Credits expire about 90 days after purchase whether or not anything used them, and nothing is billed at the moment they evaporate — so the cost ledger structurally cannot see the loss. That is why the clock belongs here rather than only in Settings.">
          <span className="text-2xs" style={{ color: 'var(--text-faint)' }}>
            the 90-day clock
          </span>
        </Hint>
      </header>

      {noPurchases ? (
        <p className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
          No credit purchase has been recorded. That is an empty ledger rather than an empty
          account — the balance is unknown from here, not zero. Settings → Integrations records
          a purchase and starts its expiry clock.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-2xs" style={{ color: 'var(--text-faint)' }}>
              <th className="px-4 py-2 font-normal">Driver</th>
              <th className="px-4 py-2 text-right font-normal">Unexpired</th>
              <th className="px-4 py-2 text-right font-normal">Expiring 30d</th>
              <th className="px-4 py-2 text-right font-normal">Expired</th>
              <th className="px-4 py-2 font-normal">Next expiry</th>
              <th className="px-4 py-2 text-right font-normal">Spent</th>
            </tr>
          </thead>
          <tbody>
            {credits
              .filter((c) => c.purchases > 0)
              .map((c) => (
                <tr key={c.slug} className="border-t" style={box}>
                  <td className="px-4 py-2">{c.slug}</td>
                  <td className="px-4 py-2 text-right font-mono">{c.creditsUnexpired}</td>
                  <td
                    className="px-4 py-2 text-right font-mono"
                    style={{
                      color: c.creditsExpiring30d > 0 ? 'var(--state-review)' : 'var(--text-muted)',
                    }}
                  >
                    {c.creditsExpiring30d}
                  </td>
                  <td
                    className="px-4 py-2 text-right font-mono"
                    style={{ color: c.creditsExpired > 0 ? 'var(--state-blocked)' : 'var(--text-faint)' }}
                  >
                    {c.creditsExpired}
                  </td>
                  <td className="px-4 py-2 text-2xs" style={{ color: 'var(--text-muted)' }}>
                    {c.daysUntilExpiry === null
                      ? 'nothing unexpired'
                      : `${c.daysUntilExpiry} day${c.daysUntilExpiry === 1 ? '' : 's'} — ${c.nextExpiry}`}
                  </td>
                  {/*
                    Not a balance. `generations.credits_spent` has no writer, so the purchase
                    total is not what is left, and rendering it as one would be a stale
                    constant shown as a live figure.
                  */}
                  <td className="px-4 py-2 text-right font-mono">
                    {c.consumptionObserved ? (
                      c.creditsSpent
                    ) : (
                      <span style={{ color: 'var(--text-faint)' }}>not recorded</span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      {!noPurchases && credits.some((c) => !c.consumptionObserved) && (
        <p className="border-t px-4 py-2 text-2xs" style={{ ...box, color: 'var(--text-faint)' }}>
          Consumption is not recorded — nothing writes a credit figure back onto a generation
          yet — so what is left is unknown rather than equal to what is unexpired. The expiry
          columns are exact; the balance is not shown because there is not one.
        </p>
      )}
    </div>
  );
}
