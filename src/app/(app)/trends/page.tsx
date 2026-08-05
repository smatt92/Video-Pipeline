import { readTrendBoard, type SourceHealth, type TrendTerm } from '@/lib/trends/read';

/**
 * Trends — what stage 1 has captured, and whether it is still capturing.
 *
 * ── The trap this was designed against, before it was written ────────────────
 *
 * The obvious shape is a list of terms. That list looks **identical after one intake and
 * after fifty**: the same words, in some order, with no way to tell a healthy pipeline from
 * one that ran once in March. It is the same defect as a costs page that is a big number, or
 * a board deriving its state from row counts — plausible, wired, and unable to distinguish
 * the two situations you actually care about.
 *
 * So every term carries how many days it was observed and the window it was observed in, and
 * the source panel comes first. Reading down the page you can answer "is intake working?"
 * before "what did it find?", which is the order the questions actually arrive in.
 *
 * ── Three states that used to be one ─────────────────────────────────────────
 *
 * Nothing on screen used to distinguish *never captured*, *captured nothing lately*, and
 * *this source has gone quiet*. They send a person to three different places — to whether
 * the task has ever run, to whether the feeds are returning anything, and to one source's
 * configuration — and they are now three different messages.
 *
 * ── There is no Run now button, deliberately ─────────────────────────────────
 *
 * `runTrendsNowAction` exists and is not called from here. Stage 1 hits somebody else's
 * public feed, and how often to do that is a decision nobody has made — §4 of ARCHITECTURE
 * says cron four times daily. A button would make the unmade decision look made. This screen
 * is the reader that had to exist first; the trigger follows the schedule decision.
 */

export const dynamic = 'force-dynamic';

export default async function TrendsPage() {
  const result = await readTrendBoard();

  if (!result.ok) {
    return (
      <Shell>
        <p style={{ color: 'var(--state-blocked)' }}>{result.error}</p>
        <p className="mt-1" style={{ color: 'var(--text-muted)' }}>{result.hint}</p>
      </Shell>
    );
  }

  const { board } = result;

  return (
    <Shell>
      {board.everCapturedAt === null ? (
        <p style={{ color: 'var(--text-muted)' }}>
          Stage 1 has never captured anything. Not &ldquo;no trends today&rdquo; — no intake has ever run
          against this workspace. That is a task that has not been triggered, not a set of
          feeds that returned nothing.
        </p>
      ) : (
        <>
          <p className="mb-4 text-xs" style={{ color: 'var(--text-muted)' }}>
            {board.totalSignals === 0 ? (
              <>
                Nothing captured in the last {board.windowDays} days. The last signal of any
                kind arrived <Stamp at={board.everCapturedAt} />, so intake has run — it has
                just not run lately.
              </>
            ) : (
              <>
                {board.totalSignals} signal{board.totalSignals === 1 ? '' : 's'} across{' '}
                {board.terms.length} term{board.terms.length === 1 ? '' : 's'} in the last{' '}
                {board.windowDays} days. Most recent <Stamp at={board.everCapturedAt} />.
              </>
            )}
          </p>

          <Section title="Sources">
            <table className="w-full text-2xs">
              <thead>
                <tr style={{ color: 'var(--text-faint)' }}>
                  <th className="pb-1 text-left font-normal">Source</th>
                  <th className="pb-1 text-right font-normal">Signals</th>
                  <th className="pb-1 text-right font-normal">Terms</th>
                  <th className="pb-1 text-left font-normal">Last capture</th>
                </tr>
              </thead>
              <tbody>
                {board.sources.map((s) => (
                  <SourceRow key={s.source} source={s} windowDays={board.windowDays} />
                ))}
              </tbody>
            </table>
          </Section>

          {board.terms.length > 0 && (
            <Section title={`Terms · last ${board.windowDays} days`}>
              <table className="w-full text-2xs">
                <thead>
                  <tr style={{ color: 'var(--text-faint)' }}>
                    <th className="pb-1 text-left font-normal">Term</th>
                    <th className="pb-1 text-left font-normal">Source</th>
                    <th className="pb-1 text-right font-normal">Days seen</th>
                    <th className="pb-1 text-right font-normal">Velocity</th>
                    <th className="pb-1 text-right font-normal">Volume</th>
                    <th className="pb-1 text-left font-normal">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {board.terms.map((t) => (
                    <TermRow key={`${t.source}-${t.term}`} term={t} />
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-2xs" style={{ color: 'var(--text-faint)' }}>
                Days seen, not fetches — intake keeps one reading per term per day. Velocity
                is a source-normalised proxy, not a measurement; an em dash means the source
                did not supply one, which is different from zero.
              </p>
            </Section>
          )}
        </>
      )}
    </Shell>
  );
}

function SourceRow({ source, windowDays }: { source: SourceHealth; windowDays: number }) {
  // Three distinct states, three distinct sentences. A source that has gone quiet is the one
  // worth seeing and the one a rows-only screen would have omitted entirely.
  const quiet = source.lastCapturedAt === null;
  return (
    <tr>
      <td className="py-0.5">{source.label}</td>
      <td className="py-0.5 text-right">{source.signals}</td>
      <td className="py-0.5 text-right">{source.distinctTerms}</td>
      <td className="py-0.5" style={{ color: quiet ? 'var(--state-blocked)' : undefined }}>
        {quiet ? `nothing in ${windowDays} days` : <Stamp at={source.lastCapturedAt!} />}
      </td>
    </tr>
  );
}

function TermRow({ term }: { term: TrendTerm }) {
  return (
    <tr>
      <td className="py-0.5">{term.term}</td>
      <td className="py-0.5" style={{ color: 'var(--text-muted)' }}>{term.source}</td>
      <td className="py-0.5 text-right">{term.timesSeen}</td>
      <td className="py-0.5 text-right">{term.velocity === null ? '—' : term.velocity}</td>
      <td className="py-0.5 text-right">{term.volume === null ? '—' : term.volume}</td>
      <td className="py-0.5"><Stamp at={term.lastSeenAt} /></td>
    </tr>
  );
}

/** Date only. Computed on the server so it cannot disagree with a client's timezone. */
function Stamp({ at }: { at: string }) {
  return <span>{at.slice(0, 10)}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-xs" style={{ color: 'var(--text-primary)' }}>{title}</h2>
      {children}
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-6 py-5">
      <h1 className="mb-1 text-sm" style={{ color: 'var(--text-primary)' }}>Trends</h1>
      <p className="mb-4 text-2xs" style={{ color: 'var(--text-faint)' }}>
        Stage 1 intake. What was captured, from where, and how recently.
      </p>
      {children}
    </div>
  );
}
