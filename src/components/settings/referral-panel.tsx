import { serverClient } from '@/lib/db/server';

/**
 * Signups attributable to Kiln, read back quietly.
 *
 * ── Why this is a diagnostic and not a conversion figure ─────────────────────
 *
 * `v_referral_attribution` counts two things per vendor: accounts connected through a
 * referral code, and how many of those ever verified. Its own comment carries the reason
 * both are shown: *"accounts_verified is the honest denominator for any conversion claim —
 * a connected integration that never verified is a form somebody filled in, not a working
 * account."*
 *
 * So this deliberately states two counts and computes no rate. A percentage here would be
 * a number to quote at a vendor, and the framing of a number you quote at somebody is a
 * decision this screen is not entitled to make on its own. Two counts side by side cannot
 * overstate; one derived rate can, and the way it overstates is by dividing by the wrong
 * denominator — which is the exact mistake the view was built to make hard.
 *
 * ── Absent is not zero, again ────────────────────────────────────────────────
 *
 * No rows means no integration has ever been connected through a referral code. That is
 * not "0 signups" — it is a screen with nothing to report, and it says so in those words.
 * A `0` here would be a claim that referrals were tried and produced nothing.
 *
 * ── Why it existed unread ────────────────────────────────────────────────────
 *
 * This view had no caller. That is the pattern this project keeps finding: a thing built to
 * make something visible, which is itself invisible. Reading it here is the answer to "and
 * what reads this?" — which is what the view needed to count as done in the first place.
 */

interface Row {
  driver: string | null;
  referral_source: string | null;
  period: string | null;
  accounts_connected: number | null;
  accounts_verified: number | null;
}

export async function ReferralPanel() {
  const { data, error } = await serverClient()
    .from('v_referral_attribution')
    .select('driver, referral_source, period, accounts_connected, accounts_verified')
    .order('period', { ascending: false });

  // A failed read is reported, not swallowed into an empty state. "Nothing to report" and
  // "could not ask" are different facts and the difference is the whole point of the panel.
  if (error) {
    return (
      <Frame>
        <span style={{ color: 'var(--state-blocked)' }}>
          Could not read referral attribution: {error.message}
        </span>
      </Frame>
    );
  }

  const rows = (data ?? []) as Row[];

  if (rows.length === 0) {
    return (
      <Frame>
        No integration has been connected through a referral link yet — nothing to report,
        which is different from none having converted.
      </Frame>
    );
  }

  // `count(*)` is a bigint and arrives as a string. `Number()` at the boundary, deliberately:
  // these are row counts, so the range is known safe and the precision loss is accepted
  // rather than incurred. A bigint id in this position would have to stay a string.
  const total = rows.reduce((n, r) => n + Number(r.accounts_connected ?? 0), 0);
  const verified = rows.reduce((n, r) => n + Number(r.accounts_verified ?? 0), 0);

  return (
    <Frame>
      <div className="mb-2">
        <strong style={{ color: 'var(--text-primary)' }}>
          {total} connected · {verified} verified
        </strong>{' '}
        through referral links. The second number is the honest one: a connection that never
        verified is a form somebody filled in.
      </div>

      <table className="w-full text-2xs">
        <thead>
          <tr style={{ color: 'var(--text-faint)' }}>
            <th className="pb-1 text-left font-normal">Vendor</th>
            <th className="pb-1 text-left font-normal">From</th>
            <th className="pb-1 text-left font-normal">Month</th>
            <th className="pb-1 text-right font-normal">Connected</th>
            <th className="pb-1 text-right font-normal">Verified</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.driver}-${r.referral_source}-${r.period}-${i}`}>
              <td className="py-0.5">{r.driver ?? '—'}</td>
              <td className="py-0.5">{r.referral_source ?? '—'}</td>
              <td className="py-0.5">{r.period ?? '—'}</td>
              <td className="py-0.5 text-right">{Number(r.accounts_connected ?? 0)}</td>
              <td className="py-0.5 text-right">{Number(r.accounts_verified ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mt-6 rounded-sm border px-3 py-2 text-xs leading-relaxed"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--surface-inset)',
        color: 'var(--text-muted)',
      }}
    >
      {children}
    </div>
  );
}
