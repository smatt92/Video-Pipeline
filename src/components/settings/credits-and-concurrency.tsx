'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import { Row } from '@/components/settings/parts';
import type { StepState } from '@/lib/onboarding/actions';
import { recordCreditPurchase, setConcurrency } from '@/lib/onboarding/actions';

/**
 * The two things the vendors will not tell us, asked for instead of guessed.
 *
 * Both replaced a probe that could only ever report failure. The rule they came from: a
 * check that can never pass has no business existing — a red X still red next month
 * teaches you to ignore red Xs, which costs more than the missing fact was worth.
 */

const IDLE: StepState = { status: 'idle' };

function Save({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-sm px-[10px] py-[5px] text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: 'var(--accent)',
        color: 'var(--accent-contrast)',
        transitionDuration: 'var(--duration-fast)',
      }}
    >
      {pending ? 'Saving…' : label}
    </button>
  );
}

function Small({
  name,
  placeholder,
  type = 'text',
  defaultValue,
  width = 'w-[110px]',
  label,
}: {
  name: string;
  placeholder?: string;
  type?: string;
  defaultValue?: string;
  width?: string;
  label: string;
}) {
  return (
    <label className="flex flex-col gap-[3px]">
      <span
        className="font-mono text-[9.5px] uppercase tracking-[0.08em]"
        style={{ color: 'var(--text-faint)' }}
      >
        {label}
      </span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className={`${width} rounded-sm border bg-transparent px-2 py-[5px] font-mono text-[12px] outline-none`}
        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
      />
    </label>
  );
}

function Result({ state }: { state: StepState }) {
  if (state.status === 'idle' || !state.message) return null;
  return (
    <p
      className="mt-2 max-w-[62ch] text-[11.5px] leading-relaxed"
      style={{ color: state.status === 'ok' ? 'var(--state-live)' : 'var(--state-blocked)' }}
    >
      {state.message}
    </p>
  );
}

export interface CreditPosition {
  creditsUnexpired: number;
  creditsExpired: number;
  nextExpiry: string | null;
  daysUntilExpiry: number | null;
  purchases: {
    id: string;
    credits: number;
    purchasedAt: string;
    expiresAt: string | null;
    amountUsd: number | null;
    note: string | null;
  }[];
}

/**
 * Credits, and the clock that matters.
 *
 * The balance was never the interesting number — the expiry was. Nothing is billed at the
 * moment credits evaporate, so it is a cost the ledger structurally cannot see, and the
 * only place it can appear is a countdown someone looks at.
 */
export function CreditsPanel({
  slug,
  position,
  today,
}: {
  slug: string;
  position: CreditPosition;
  today: string;
}) {
  const [state, action] = useActionState(recordCreditPurchase.bind(null, slug), IDLE);

  const days = position.daysUntilExpiry;
  // Three weeks is roughly the lead time on noticing, deciding and buying. Under a week is
  // "this is happening".
  const tone =
    days === null
      ? 'var(--text-faint)'
      : days <= 7
        ? 'var(--state-blocked)'
        : days <= 21
          ? 'var(--state-review)'
          : 'var(--state-live)';

  return (
    <>
      <Row
        label="Credit position"
        help="Entered by hand. The vendor API exposes no account or balance endpoint, and a guessed number would be believed."
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-4">
            <span className="font-mono text-[15px]" style={{ color: 'var(--text-primary)' }}>
              {position.creditsUnexpired.toLocaleString()}
            </span>
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              unexpired
            </span>
            {days !== null && (
              <span className="font-mono text-[11.5px]" style={{ color: tone }}>
                nearest tranche expires in {days} day{days === 1 ? '' : 's'} ({position.nextExpiry})
              </span>
            )}
            {days === null && (
              <span className="text-[11.5px]" style={{ color: 'var(--text-faint)' }}>
                no purchase recorded — nothing is watching the clock
              </span>
            )}
          </div>

          {position.creditsExpired > 0 && (
            <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              {position.creditsExpired.toLocaleString()} credits have already expired. That
              never appears in the cost ledger — nothing is billed when credits evaporate —
              which is the whole reason this panel exists.
            </p>
          )}

          {position.purchases.length > 0 && (
            <table className="mt-1 w-full max-w-[520px] text-[11.5px]">
              <thead>
                <tr style={{ color: 'var(--text-faint)' }}>
                  <th className="pb-1 text-left font-mono text-[9.5px] font-normal uppercase tracking-[0.08em]">
                    credits
                  </th>
                  <th className="pb-1 text-left font-mono text-[9.5px] font-normal uppercase tracking-[0.08em]">
                    bought
                  </th>
                  <th className="pb-1 text-left font-mono text-[9.5px] font-normal uppercase tracking-[0.08em]">
                    expires
                  </th>
                  <th className="pb-1 text-right font-mono text-[9.5px] font-normal uppercase tracking-[0.08em]">
                    usd
                  </th>
                </tr>
              </thead>
              <tbody>
                {position.purchases.map((p) => {
                  const dead = p.expiresAt !== null && p.expiresAt < today;
                  return (
                    <tr
                      key={p.id}
                      style={{ color: dead ? 'var(--text-faint)' : 'var(--text-secondary)' }}
                    >
                      <td className="py-[2px] font-mono">{p.credits.toLocaleString()}</td>
                      <td className="py-[2px] font-mono">{p.purchasedAt}</td>
                      <td className="py-[2px] font-mono">
                        {p.expiresAt}
                        {dead && ' · lapsed'}
                      </td>
                      <td className="py-[2px] text-right font-mono">
                        {p.amountUsd === null ? '—' : `$${p.amountUsd}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Row>

      <Row
        label="Record a purchase"
        help="One row per purchase, because credits expire per purchase — two top-ups are two clocks. Filling in the amount is what makes a verified per-credit rate possible, which is what unblocks the rate-card step."
      >
        <form action={action} className="flex flex-wrap items-end gap-3">
          <Small name="credits" label="credits" placeholder="1000" />
          <Small name="purchased_at" label="bought" type="date" defaultValue={today} width="w-[140px]" />
          <Small name="expiry_days" label="expires in" defaultValue="90" width="w-[80px]" />
          <Small name="amount_usd" label="usd" placeholder="49.00" width="w-[90px]" />
          <Small name="note" label="note" placeholder="optional" width="w-[140px]" />
          <Save label="Record" />
        </form>
        <Result state={state} />
      </Row>
    </>
  );
}

/**
 * The parallel-request ceiling, and whether anybody actually read it.
 *
 * `source` is the point of this panel. A limit that was read from the account and a limit
 * that was assumed deserve different confidence, and a screen that cannot tell them apart
 * will present the assumption as fact — which is how a conservative default gets quietly
 * trusted as the real number, or worse, how a guessed-high number gets blamed on the vendor.
 */
export function ConcurrencyPanel({
  slug,
  limit,
  source,
  fallback,
}: {
  slug: string;
  limit: number | null;
  source: string;
  fallback: number;
}) {
  const [state, action] = useActionState(setConcurrency.bind(null, slug), IDLE);

  const effective = limit ?? fallback;
  const explanation: Record<string, string> = {
    tier: 'Read from the account during verification.',
    manual: 'Set by hand. A check re-run will not overwrite it.',
    default:
      `Nothing established a real limit, so this is a fallback — the lowest ceiling any ` +
      `plan has. Guessing high produces a steady failure rate that reads as an unreliable ` +
      `vendor; guessing low is only slow.`,
  };

  return (
    <Row
      label="Parallel requests"
      help="What the queue is allowed to have in flight at once. Read by the queue at run time, never hardcoded."
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[15px]" style={{ color: 'var(--text-primary)' }}>
            {effective}
          </span>
          <span
            className="rounded-xs px-[6px] py-[2px] font-mono text-[10px] uppercase"
            style={{
              background: 'var(--surface-2)',
              color: source === 'default' ? 'var(--state-review)' : 'var(--text-muted)',
            }}
          >
            {source === 'default' ? 'assumed' : source}
          </span>
        </div>

        <p className="max-w-[62ch] text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {explanation[source] ?? explanation.default}
        </p>

        <form action={action} className="flex items-end gap-3">
          <Small
            name="concurrency_limit"
            label="override"
            placeholder={String(effective)}
            width="w-[90px]"
          />
          <Save label="Set" />
          <span className="pb-[6px] text-[11px]" style={{ color: 'var(--text-faint)' }}>
            blank clears the override
          </span>
        </form>
        <Result state={state} />
      </div>
    </Row>
  );
}
