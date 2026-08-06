import { PublishButton } from '@/components/publish/publish-button';
import { QUEUE_PAGE, readPublishBoard } from '@/lib/publish/read';

/**
 * Publish — stage 10. What is waiting, what is stopping it, and what today's quota allows.
 *
 * ── The inverse test, which was the first requirement rather than the last ───
 *
 * A publish queue that renders identically after one upload and after a hundred is the trap
 * named up front, and this project has found that shape five times — the costs page, the
 * trends list, the review queue, the Studio list, the analytics screen — plus three silent
 * `.limit()` caps. So the counts here come from the database over the whole view, never
 * from `rows.length`, and when the two disagree the page says which rows it is not showing.
 * A cap you can see is a limitation; a cap you cannot is a lie about scale.
 *
 * ── The quota block is the first honest countdown in this product ────────────
 *
 * Every other vendor limit is in `observability.ts` as withheld, because the vendor
 * publishes no counter and our consumption is unobservable. This one is different for a
 * specific reason: we make every call and each price is published, so consumption is
 * something we already know. The ceiling is still Google's documented figure, and the
 * screen labels it — `quota_source` is rendered beside the number rather than dropped,
 * because a remaining figure derived from an assumed ceiling is honest only while it says
 * so.
 *
 * ── Credential health says "last confirmed", never "expires" ─────────────────
 *
 * A refresh token's expiry is not knowable — see `src/lib/publish/token-health.ts`. What is
 * shown is when a refresh last actually worked, which is a fact, and how many have failed
 * since, which is what an alert is really asking.
 */

const MAX_W = 'mx-auto w-full max-w-[1400px]';

const BLOCKER_COPY: Record<string, string> = {
  review_not_passed: 'no passing review — the database gate refuses this, not the screen',
  render_not_ready: 'the render has not finished',
  disclosure_not_set: 'altered-content disclosure is not set',
  no_verified_publish_integration: 'no verified publish credential in this workspace',
  insufficient_quota: 'not enough quota left today for an upload (1,600 units)',
  scheduled_for_later: 'scheduled for later',
  ready: 'ready',
};

export default async function PublishPage() {
  const board = await readPublishBoard();
  const shown = board.rows.length;
  const capped = board.queueTotal > shown;

  return (
    <main className={`${MAX_W} px-6 py-8`}>
      <header>
        <h1 className="text-lg font-medium">Publish</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Stage 10, YouTube. Uploads run on a worker and never through a route — a finished
          render is far past what a serverless function may carry. Every upload declares
          altered content; the publish gate is a database trigger and has no override.
        </p>
      </header>

      {board.unreadable.length > 0 && (
        <div
          className="mt-6 rounded-md border px-4 py-3 text-sm"
          style={{ borderColor: 'var(--state-blocked)', background: 'var(--state-blocked-bg)' }}
        >
          <div className="font-medium">Part of this screen could not be read.</div>
          <p className="mt-1" style={{ color: 'var(--text-muted)' }}>
            A failed read, not an empty queue. Usually migration 0035 has not been applied —
            run <code className="font-mono">pnpm db:doctor</code>.
          </p>
          <ul className="mt-2 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
            {board.unreadable.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Denominator first. See the note at the top of this file. */}
      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        <Figure label="In the queue" value={String(board.queueTotal)} emphasis />
        <Figure
          label="Published"
          value={String(board.liveTotal)}
          sub="live on the channel"
        />
        <Figure
          label="Ready now"
          value={String(board.byBlocker.ready ?? 0)}
          sub="nothing is blocking these"
        />
        <Figure
          label="Quota left today"
          value={
            board.quota === null
              ? '—'
              : board.quota.unitsRemaining.toLocaleString('en-IN')
          }
          sub={
            board.quota === null
              ? (board.quotaUnavailableReason ?? 'not counted')
              : `of ${board.quota.dailyQuotaUnits.toLocaleString('en-IN')} · ceiling is ${board.quota.quotaSource}`
          }
        />
      </section>

      {board.quota && (
        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          {board.quota.unitsUsed.toLocaleString('en-IN')} units used across{' '}
          {board.quota.callsMade} call{board.quota.callsMade === 1 ? '' : 's'} this window
          {board.quota.unitsWasted > 0 && (
            <>
              {' '}
              — <strong>{board.quota.unitsWasted.toLocaleString('en-IN')} of them on calls
              that failed</strong>
            </>
          )}
          . Resets {new Date(board.quota.windowResetsAt).toLocaleString()}, which is midnight
          in the vendor&rsquo;s timezone rather than yours. An upload costs 1,600 units, so{' '}
          {Math.floor(board.quota.unitsRemaining / 1600)} more fit today.
          {board.quota.quotaSource === 'documented' && (
            <>
              {' '}
              The 10,000 ceiling is the vendor&rsquo;s published figure — nobody here has
              watched it hold, and the usage figure beside it is counted from our own calls.
            </>
          )}
        </p>
      )}

      {/* A visible cap. The whole point of counting in the database. */}
      {capped && (
        <p className="mt-3 text-xs" style={{ color: 'var(--state-warn)' }}>
          Showing the first {shown} of {board.queueTotal}. This page caps at {QUEUE_PAGE}, and
          says so rather than looking complete — a display cap nobody can see is how a queue
          renders the same at two scales.
        </p>
      )}

      {/* ── Credential health ─────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">Credential</h2>
        {board.credentials.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            No active channel. Nothing to publish to yet.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {board.credentials.map((c) => (
              <li key={c.channelId} className="text-xs">
                <span className="font-medium">{c.name}</span>{' '}
                {/* "Last confirmed", never "expires". A refresh token's expiry is not
                    knowable; that it worked eight minutes ago is a fact. */}
                <span style={{ color: 'var(--text-muted)' }}>
                  {c.lastRefreshedAt
                    ? `last confirmed working ${new Date(c.lastRefreshedAt).toLocaleString()}`
                    : 'never confirmed — no refresh has succeeded yet, which is not the same as broken'}
                </span>
                {c.consecutiveFailures > 0 && (
                  <span style={{ color: 'var(--state-blocked)' }}>
                    {' '}
                    · {c.consecutiveFailures} consecutive failure
                    {c.consecutiveFailures === 1 ? '' : 's'}
                    {c.refreshError ? ` — ${c.refreshError}` : ''}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── The queue ─────────────────────────────────────────────────────── */}
      <section className="mt-8">
        <h2 className="text-sm font-medium">Queue</h2>
        {board.rows.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            {board.liveTotal > 0
              ? 'Nothing waiting — everything reviewed has been published.'
              : 'Nothing has reached a passing review yet. This is an empty queue, not a broken one.'}
          </p>
        ) : (
          <table className="mt-3 w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--text-faint)' }}>
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Attempts</Th>
                <Th>Disclosed</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {board.rows.map((r) => (
                <tr
                  key={r.publicationId}
                  className="border-t"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <Td>{r.title}</Td>
                  <Td>
                    {r.status}
                    {r.blocker && (
                      <span style={{ color: 'var(--text-faint)' }}>
                        {' '}
                        — {BLOCKER_COPY[r.blocker] ?? r.blocker}
                      </span>
                    )}
                    {r.errorDetail && (
                      <span style={{ color: 'var(--state-blocked)' }}> — {r.errorDetail}</span>
                    )}
                  </Td>
                  <Td>{r.uploadAttempts}</Td>
                  {/* No tick for false. The disclosure is a compliance control and an
                      un-set one has to look like a problem, not like an empty cell. */}
                  <Td>
                    {r.alteredContentDisclosed ? (
                      'yes'
                    ) : (
                      <span style={{ color: 'var(--state-blocked)' }}>not set</span>
                    )}
                  </Td>
                  <Td>
                    <PublishButton
                      publicationId={r.publicationId}
                      blocker={r.blocker}
                      unitsRemaining={board.quota?.unitsRemaining ?? null}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function Figure({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className="rounded-md border px-4 py-3"
      style={{
        borderColor: emphasis ? 'var(--border-strong)' : 'var(--border-subtle)',
        background: 'var(--surface-1)',
      }}
    >
      <div className="text-2xs uppercase" style={{ color: 'var(--text-faint)' }}>
        {label}
      </div>
      <div className={emphasis ? 'mt-1 text-xl' : 'mt-1 text-lg'}>{value}</div>
      {sub && (
        <div className="mt-1 text-2xs" style={{ color: 'var(--text-muted)' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="py-1 text-left text-2xs font-normal uppercase">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-1 font-mono text-2xs">{children}</td>;
}
