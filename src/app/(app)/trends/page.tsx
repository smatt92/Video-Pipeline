import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import type { ChannelSummary } from '@/lib/channels/list';
import { serverClient } from '@/lib/db/server';
import { DEFAULT_GOOGLE_TRENDS_GEOS } from '@/lib/drivers/trends-google';
import { DEFAULT_HN_TOP_N } from '@/lib/drivers/trends-hn';
import { DEFAULT_WIKIPEDIA_LANGUAGES, DEFAULT_WIKIPEDIA_TOP_N } from '@/lib/drivers/trends-wikipedia';
import { redditCredentialsFromEnv } from '@/lib/drivers/trends-reddit';
import { youtubeApiKeyFromEnv } from '@/lib/drivers/trends-youtube';
import { RunNow } from '@/components/trends/run-now';
import { readTrendBoard, type SourceHealth, type TrendBoard, type TrendTerm } from '@/lib/trends/read';
import { latestTrendRun, SOURCE_LABEL, type LatestTrendRun } from '@/lib/trends/runs';

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
 * ── Per channel, with Run now ────────────────────────────────────────────────
 *
 * Everything here is for the active channel (the sidebar switcher): its sources as its
 * `channels/<slug>/trends.json` configures them, and the signals written under its
 * channel_id. Signals with no channel predate 0046; they are shown labelled "workspace-wide
 * (before multichannel)", so they are neither silently mixed in nor silently hidden. The schedule
 * (`01-trends`, four times a day) collects for every channel; Run now collects for this one,
 * approver only — the action refuses anyone else.
 */

export const dynamic = 'force-dynamic';

export default async function TrendsPage() {
  let channel: ChannelSummary;
  try {
    channel = await requireChannel();
  } catch (err) {
    return (
      <Shell>
        <p style={{ color: 'var(--blk)' }}>{err instanceof Error ? err.message : String(err)}</p>
      </Shell>
    );
  }
  const [result, lastRun] = await Promise.all([readTrendBoard(channel.id), latestTrendRun(serverClient(), channel.id)]);

  return (
    <Shell>
      <ChannelSources channel={channel} />
      <LastRun last={lastRun} />
      {!result.ok ? (
        <>
          <p style={{ color: 'var(--blk)' }}>{result.error}</p>
          <p className="mt-1" style={{ color: 'var(--t3)' }}>{result.hint}</p>
        </>
      ) : (
        <Board board={result.board} channelName={channel.name} />
      )}
    </Shell>
  );
}

/** What this channel collects from, read from its bible — the same config Run now sends. */
function ChannelSources({ channel }: { channel: ChannelSummary }) {
  const cb = bibleOrNull(channel);
  const yt = cb?.trends.youtube ?? null;
  const keySet = youtubeApiKeyFromEnv() !== null;
  // Read where this page renders (Vercel). The worker gets the same values copied at deploy
  // (0017), so after setting them the worker needs one redeploy before a run can use them.
  const redditSet = redditCredentialsFromEnv() !== null;
  const gt = cb?.trends.google_trends;
  const wiki = cb?.trends.wikipedia;
  const hn = cb?.trends.hn;
  return (
    <Section title={`Channel · ${channel.name}`}>
      {!cb ? (
        <p className="text-2xs" style={{ color: 'var(--blk)' }}>
          No bible folder for slug {channel.slug ?? '(unset)'} in this build, so no trends.json —
          neither the schedule nor Run now collects anything for this channel.
        </p>
      ) : (
        <div className="text-2xs" style={{ color: 'var(--t3)' }}>
          <p>
            Reddit:{' '}
            {cb.trends.subreddits.length ? cb.trends.subreddits.map((s) => `r/${s}`).join(', ') : 'none configured'}
            {cb.trends.subreddits.length > 0 && redditSet && <span> — REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are set</span>}
            {cb.trends.subreddits.length > 0 && !redditSet && (
              <span style={{ color: 'var(--blk)' }}>
                {' '}— not configured: Reddit refuses unauthenticated reads (403). Create a “script” app at reddit.com/prefs/apps and put
                REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET in Vercel production, then redeploy the worker.
              </span>
            )}
          </p>
          {cb.trends.subreddits.length > 0 && (
            <p className="mt-0.5">
              Reddit’s free API tier is for non-commercial use. Whether a monetised channel counts as commercial is
              Reddit’s terms to read and yours to decide.
            </p>
          )}
          <p className="mt-0.5">
            YouTube:{' '}
            {yt
              ? `region ${yt.region_code} · categories ${yt.category_ids.join(', ') || 'none'} · queries ${
                  yt.queries.map((q) => `“${q}”`).join(', ') || 'none'
                }`
              : 'not configured'}
            {yt && keySet && <span> — YOUTUBE_DATA_API_KEY is set</span>}
            {yt && !keySet && (
              <span style={{ color: 'var(--blk)' }}> — YOUTUBE_DATA_API_KEY is not set, so this source refuses</span>
            )}
          </p>
          <p className="mt-0.5">
            Google Trends:{' '}
            {gt === null
              ? 'off for this channel (google_trends: null)'
              : `trending searches in ${(gt?.geo ?? DEFAULT_GOOGLE_TRENDS_GEOS).join(', ')}${gt ? '' : ' (default)'} — the public RSS feed, no key; volume is its approximate traffic, a lower bound`}
          </p>
          <p className="mt-0.5">
            Wikipedia:{' '}
            {wiki === null
              ? 'off for this channel (wikipedia: null)'
              : `yesterday’s ${wiki?.top_n ?? DEFAULT_WIKIPEDIA_TOP_N} most-viewed articles in ${(wiki?.languages ?? DEFAULT_WIKIPEDIA_LANGUAGES).join(', ')}${wiki ? '' : ' (default)'} — no key; volume is views, velocity the change against the day before (blank when the article was not in that day’s list)`}
          </p>
          <p className="mt-0.5">
            Hacker News:{' '}
            {hn === null
              ? 'off for this channel (hn: null)'
              : `top ${hn?.top_n ?? DEFAULT_HN_TOP_N} stories${hn ? '' : ' (default)'} — no key; volume is score, velocity score per hour since posted`}
          </p>
          <p className="mt-0.5" style={{ color: 'var(--t3)' }}>
            From channels/{cb.slug}/trends.json. Collected automatically at 06:10, 12:10, 18:10 and 00:10 IST.
          </p>
          <div className="mt-2">
            <RunNow channelId={channel.id} />
          </div>
        </div>
      )}
    </Section>
  );
}

/** What each source said on the latest run — a refusal is a sentence, never a blank. */
function LastRun({ last }: { last: LatestTrendRun }) {
  return (
    <Section title="Latest run">
      {!last.ok ? (
        <p className="text-2xs" style={{ color: 'var(--t3)' }}>{last.reason}</p>
      ) : !last.run ? (
        <p className="text-2xs" style={{ color: 'var(--t3)' }}>No run has been recorded for this channel since per-run results began (0049).</p>
      ) : (
        <div className="text-2xs">
          <p style={{ color: 'var(--t3)' }}>
            {last.run.finishedAt.slice(0, 16).replace('T', ' ')} UTC · {last.run.trigger === 'now' ? 'Run now' : last.run.trigger} · {last.run.inserted} new,{' '}
            {last.run.updated} updated
          </p>
          <ul className="mt-1">
            {last.run.sources.map((s) => (
              <li key={s.source} style={{ color: s.ok ? undefined : /^not configured/.test(s.detail ?? '') ? 'var(--t3)' : 'var(--blk)' }}>
                {SOURCE_LABEL[s.source] ?? s.source}: {s.ok ? `${s.count} signal${s.count === 1 ? '' : 's'}${s.detail ? ` — ${s.detail}` : ''}` : s.detail ?? 'failed, no reason recorded'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Board({ board, channelName }: { board: TrendBoard; channelName: string }) {
  return (
    <>
      {board.scope === 'workspace' && (
        <p className="mb-3 text-2xs" style={{ color: 'var(--blk)' }}>
          This database has no trend_signals.channel_id (migration 0046 not applied), so the board below
          is every channel&rsquo;s signals, not {channelName}&rsquo;s alone.
        </p>
      )}
      {board.scope === 'channel' && board.workspaceWideInWindow > 0 && (
        <p className="mb-3 text-2xs" style={{ color: 'var(--t3)' }}>
          {board.workspaceWideInWindow} of these signal{board.workspaceWideInWindow === 1 ? '' : 's'} have
          no channel — captured before per-channel intake — and are marked workspace-wide below.
        </p>
      )}
      {board.everCapturedAt === null ? (
        <p style={{ color: 'var(--t3)' }}>
          Stage 1 has never captured anything for this channel. Not &ldquo;no trends today&rdquo; — no
          intake has ever written a signal under it. That is a task that has not run, not a set of
          feeds that returned nothing.
        </p>
      ) : (
        <>
          <p className="mb-4 text-xs" style={{ color: 'var(--t3)' }}>
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
                <tr style={{ color: 'var(--t3)' }}>
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
                  <tr style={{ color: 'var(--t3)' }}>
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
                    <TermRow key={`${t.workspaceWide ? 'w' : 'c'}-${t.source}-${t.term}`} term={t} showScope={board.scope === 'channel'} />
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-2xs" style={{ color: 'var(--t3)' }}>
                Days seen, not fetches — intake keeps one reading per term per day. Velocity
                is a source-normalised proxy (Reddit: score per hour; YouTube: views per hour
                since publish; Google Trends supplies none), not a measurement; an em dash means
                the source did not supply one, which is different from zero.
              </p>
            </Section>
          )}
        </>
      )}
    </>
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
      <td className="py-0.5" style={{ color: quiet ? 'var(--blk)' : undefined }}>
        {quiet ? `nothing in ${windowDays} days` : <Stamp at={source.lastCapturedAt!} />}
      </td>
    </tr>
  );
}

function TermRow({ term, showScope }: { term: TrendTerm; showScope: boolean }) {
  return (
    <tr>
      <td className="py-0.5">
        {term.term}
        {showScope && term.workspaceWide && (
          <span style={{ color: 'var(--t3)' }}> · workspace-wide (before multichannel)</span>
        )}
      </td>
      <td className="py-0.5" style={{ color: 'var(--t3)' }}>{term.source}</td>
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
      <h2 className="h3" style={{ marginBottom: 8 }}>{title}</h2>
      {children}
    </section>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="main">
      <header className="topbar">
        <div className="col" style={{ gap: 4 }}>
          <div className="crumb">
            <span>Pipeline</span>
            <span className="t4">/</span>
            <span>Trends</span>
          </div>
          <h1 className="h1">Trends</h1>
          <p className="sm t3">Stage 1 intake. What was captured, from where, and how recently.</p>
        </div>
      </header>
      <div>{children}</div>
    </main>
  );
}
