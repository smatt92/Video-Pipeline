import { Icon, Pill, type StateTone } from '@/components/ui';
import { RunNow } from '@/components/trends/run-now';
import { SignalList, type SignalRow } from '@/components/trends/signal-list';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import type { ChannelSummary } from '@/lib/channels/list';
import { serverClient } from '@/lib/db/server';
import { DEFAULT_GOOGLE_TRENDS_GEOS } from '@/lib/drivers/trends-google';
import { DEFAULT_HN_TOP_N } from '@/lib/drivers/trends-hn';
import { redditCredentialsFromEnv } from '@/lib/drivers/trends-reddit';
import { DEFAULT_WIKIPEDIA_LANGUAGES, DEFAULT_WIKIPEDIA_TOP_N } from '@/lib/drivers/trends-wikipedia';
import { youtubeApiKeyFromEnv } from '@/lib/drivers/trends-youtube';
import { readChannelFlags } from '@/lib/settings/channel-flags';
import { readTrendBoard, type SourceHealth, type TrendBoard, type TrendTerm } from '@/lib/trends/read';
import { latestTrendRun, SOURCE_LABEL, sourceStatus, type LatestTrendRun, type SourceStatus, type TrendRunSource } from '@/lib/trends/runs';
import { istLabel, nextTrendsCollection } from '@/lib/trends/schedule';

/**
 * Trends — what stage 1 collects for this channel, from where, and which of it the channel can use.
 *
 * ── Redesigned (O5) ──────────────────────────────────────────────────────────
 *
 * It was a wall of text and one long table: celebrities, tickers and phone unboxings listed at
 * the same weight as the science, and "Terms" colliding with "Last capture". Now, in the order the
 * questions arrive: is intake working (a card per source, its status in one sentence), what is
 * for THIS channel (signals at or above its relevance threshold, as cards), and everything else
 * folded away with filters.
 *
 * ── What did not change ──────────────────────────────────────────────────────
 *
 * Every source is listed whether or not it produced anything (a source that went quiet is the
 * one worth seeing); never captured, nothing lately and a quiet source are three sentences; days
 * seen, not fetches; absent is "—" with its reason, never 0 — a relevance that was never scored
 * is not a relevance of 0.
 *
 * ── No "Draft a concept" button ──────────────────────────────────────────────
 *
 * Looked for: stage 2's `requestConcepts` takes a seed but nothing in the app calls it, and the
 * Bureau drafts briefs from calendar slots, not from a term. A button here would be the fifth
 * complete-and-unreachable path. The relevant signals reach drafting by being READ first — by
 * stage 2 and by the connector's trends_recent — which the section says.
 */

export const dynamic = 'force-dynamic';

const SOURCE_ORDER = ['youtube', 'google_trends', 'wikipedia', 'hn', 'reddit'] as const;

/** Units per source — a number without one is a guess about what it counts. */
const UNITS: Record<string, { velocity: string | null; volume: string | null }> = {
  reddit: { velocity: 'pts/h', volume: 'pts' },
  youtube: { velocity: 'views/h', volume: 'views' },
  google_trends: { velocity: null, volume: 'searches+' },
  wikipedia: { velocity: 'Δ views', volume: 'views/day' },
  hn: { velocity: 'pts/h', volume: 'pts' },
};

const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-IN') : String(Math.round(n * 100) / 100));
const withUnit = (n: number | null, unit: string | null) => (n === null || unit === null ? null : `${n > 0 && unit.includes('Δ') ? '+' : ''}${fmt(n)} ${unit}`);

export default async function TrendsPage() {
  let channel: ChannelSummary;
  try {
    channel = await requireChannel();
  } catch (err) {
    return (
      <Shell sub={null}>
        <div className="blocker" role="alert">
          <span>{err instanceof Error ? err.message : String(err)}</span>
        </div>
      </Shell>
    );
  }
  const db = serverClient();
  const [result, lastRun, flags] = await Promise.all([readTrendBoard(channel.id), latestTrendRun(db, channel.id), readChannelFlags(db, channel.id)]);
  const threshold = flags.values.relevanceThreshold;
  const run = lastRun.ok ? lastRun.run : null;
  const next = nextTrendsCollection();

  return (
    <Shell
      sub={
        <>
          <span>{channel.name}</span>
          <span className="t4">·</span>
          <span>Last run {run ? `${istLabel(run.finishedAt)} (${run.trigger === 'now' ? 'Run now' : run.trigger})` : lastRun.ok ? '— none recorded' : '— not recorded (see below)'}</span>
          <span className="t4">·</span>
          <span>Next collection {istLabel(next)}</span>
        </>
      }
      right={bibleOrNull(channel) ? <RunNow channelId={channel.id} /> : null}
    >
      <Sources channel={channel} last={lastRun} board={result.ok ? result.board : null} />
      {!result.ok ? (
        <div className="blocker" role="alert">
          <div className="col" style={{ gap: 2 }}>
            <span>{result.error}</span>
            <span className="xs t3">{result.hint}</span>
          </div>
        </div>
      ) : (
        <Signals board={result.board} channelName={channel.name} threshold={threshold} thresholdNote={flags.source === 'defaults' ? flags.reason : null} relevanceNote={run?.relevance ?? null} />
      )}
    </Shell>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Sources
// ═════════════════════════════════════════════════════════════════════════════

const STATUS: Record<SourceStatus | 'none', { tone: StateTone; label: string }> = {
  ok: { tone: 'live', label: 'ok' },
  partial: { tone: 'rev', label: 'partial' },
  not_configured: { tone: 'draft', label: 'not configured' },
  failed: { tone: 'blk', label: 'failed' },
  none: { tone: 'draft', label: 'no run recorded' },
};

function Sources({ channel, last, board }: { channel: ChannelSummary; last: LatestTrendRun; board: TrendBoard | null }) {
  const cb = bibleOrNull(channel);
  const run = last.ok ? last.run : null;
  return (
    <section aria-label="Sources" className="col" style={{ gap: 12 }}>
      <div className="row sb">
        <h2 className="h3">Sources</h2>
        <span className="xs t3">
          {cb ? `From ${channel.name}’s trend sources. Collected at 06:10, 12:10, 18:10 and 00:10 IST; no key or charge except YouTube’s free quota.` : ''}
        </span>
      </div>
      {!cb && (
        <div className="blocker" role="alert">
          <span>
            No bible for slug {channel.slug ?? '(unset)'}, so no trend sources — neither the schedule nor Run now collects anything for this channel.
          </span>
        </div>
      )}
      {!last.ok && <div className="note"><Icon name="info" /><span>{last.reason}</span></div>}
      <div className="kgrid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))' }}>
        {SOURCE_ORDER.map((slug) => (
          <SourceCard key={slug} slug={slug} channel={channel} recorded={run?.sources.find((s) => s.source === slug) ?? null} health={board?.sources.find((s) => s.source === slug) ?? null} windowDays={board?.windowDays ?? 30} />
        ))}
      </div>
    </section>
  );
}

function SourceCard({ slug, channel, recorded, health, windowDays }: { slug: (typeof SOURCE_ORDER)[number]; channel: ChannelSummary; recorded: TrendRunSource | null; health: SourceHealth | null; windowDays: number }) {
  const status: SourceStatus | 'none' = recorded ? sourceStatus(recorded) : 'none';
  const pill = STATUS[status];
  const label = SOURCE_LABEL[slug] ?? slug;
  return (
    <article className="card" aria-label={label} style={{ minWidth: 0 }}>
      <div className="card-b col" style={{ gap: 10 }}>
        <div className="row sb" style={{ gap: 8 }}>
          <h3 className="h3">{label}</h3>
          <Pill tone={pill.tone}>{pill.label}</Pill>
        </div>
        <p className="xs t2" style={{ overflowWrap: 'anywhere' }}>{reasonFor(slug, status, recorded)}</p>
        {recorded?.failures && recorded.failures.length > 0 && (
          <ul className="col xs" style={{ gap: 4, listStyle: 'none', padding: 0, margin: 0 }}>
            {recorded.failures.map((f) => (
              <li key={f.part} className="t3" style={{ overflowWrap: 'anywhere' }}>
                <span className="t2">{f.part}</span> — {f.kind === 'no_chart' ? `no most-popular chart in this region; the others still landed` : f.detail}
              </li>
            ))}
          </ul>
        )}
        <dl className="col xs" style={{ gap: 4, margin: 0 }}>
          <div className="row sb">
            <dt className="t3">Signals in last run</dt>
            <dd className="mono" style={{ margin: 0 }}>{recorded ? recorded.count : '—'}</dd>
          </div>
          <div className="row sb">
            <dt className="t3">Last capture</dt>
            <dd className="mono" style={{ margin: 0 }}>{health?.lastCapturedAt ? istLabel(health.lastCapturedAt) : `— none in ${windowDays} d`}</dd>
          </div>
        </dl>
        <details>
          <summary className="xs t3" style={{ cursor: 'pointer' }}>Configuration</summary>
          <p className="xs t3 mono" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{configLine(slug, channel)}</p>
        </details>
      </div>
    </article>
  );
}

/** The one sentence under the pill. */
function reasonFor(slug: string, status: SourceStatus | 'none', r: TrendRunSource | null): string {
  if (status === 'none') return 'No run has been recorded for this channel yet (runs are recorded since migration 0049).';
  // Reddit's free tier needs Reddit's approval for an app like this; not having it is a choice, not an outage.
  if (slug === 'reddit' && status === 'not_configured') return 'Not configured — Reddit requires approval (Responsible Builder Policy); off by choice.';
  if (status === 'not_configured') return (r?.detail ?? 'not configured').replace(/^not configured:\s*/i, 'Not configured: ');
  if (status === 'failed') return r?.detail ?? 'Failed, no reason recorded.';
  if (status === 'partial') return `${r!.count} signal${r!.count === 1 ? '' : 's'} landed; ${r!.failures!.length} part${r!.failures!.length === 1 ? '' : 's'} did not:`;
  return r?.detail ? `Every part answered. ${r.detail}` : 'Every part answered.';
}

function configLine(slug: string, channel: ChannelSummary): string {
  const cb = bibleOrNull(channel);
  if (!cb) return 'no trend sources (no bible)';
  const t = cb.trends;
  if (slug === 'youtube') {
    const yt = t.youtube;
    if (!yt) return 'not configured (no youtube block)';
    return `region ${yt.region_code} · categories ${yt.category_ids.join(', ') || 'none'} · queries ${yt.queries.map((q) => `“${q}”`).join(', ') || 'none'} · key ${youtubeApiKeyFromEnv() ? 'set' : 'NOT set'}`;
  }
  if (slug === 'google_trends') return t.google_trends === null ? 'off (google_trends: null)' : `trending searches in ${(t.google_trends?.geo ?? DEFAULT_GOOGLE_TRENDS_GEOS).join(', ')}${t.google_trends ? '' : ' (default)'} · volume is approximate traffic, a lower bound`;
  if (slug === 'wikipedia') return t.wikipedia === null ? 'off (wikipedia: null)' : `yesterday’s top ${t.wikipedia?.top_n ?? DEFAULT_WIKIPEDIA_TOP_N} in ${(t.wikipedia?.languages ?? DEFAULT_WIKIPEDIA_LANGUAGES).join(', ')}${t.wikipedia ? '' : ' (default)'} · velocity = change on the day before`;
  if (slug === 'hn') return t.hn === null ? 'off (hn: null)' : `top ${t.hn?.top_n ?? DEFAULT_HN_TOP_N} stories${t.hn ? '' : ' (default)'} · velocity = points per hour since posted`;
  // Reddit: read on Vercel; the worker gets the same values copied at deploy (0017).
  return `${t.subreddits.length ? t.subreddits.map((s) => `r/${s}`).join(', ') : 'no subreddits'} · app credentials ${redditCredentialsFromEnv() ? 'set' : 'not set'} · the free API tier is non-commercial`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Signals — for this channel, and everything else
// ═════════════════════════════════════════════════════════════════════════════

function Signals({
  board,
  channelName,
  threshold,
  thresholdNote,
  relevanceNote,
}: {
  board: TrendBoard;
  channelName: string;
  threshold: number;
  thresholdNote: string | null;
  relevanceNote: { scored: number; unscored: number; detail: string | null } | null;
}) {
  if (board.everCapturedAt === null) {
    return (
      <div className="empty">
        Stage 1 has never captured anything for this channel — not “no trends today”: no intake has ever written a signal under it. That is a task that has not run, not
        feeds that returned nothing.
      </div>
    );
  }
  const relevant = board.terms.filter((t) => t.relevance !== null && t.relevance >= threshold && !t.workspaceWide).sort((a, b) => b.relevance! - a.relevance! || b.timesSeen - a.timesSeen);
  const rest = board.terms.filter((t) => !relevant.includes(t)).sort((a, b) => (b.relevance ?? -2) - (a.relevance ?? -2) || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const unscored = board.terms.filter((t) => t.relevance === null).length;
  const scored = board.terms.length - unscored;
  const unscoredWhy = !board.relevanceAvailable ? 'needs migration 0051' : (relevanceNote?.detail ?? 'not scored on the run that captured it');
  const spread = scored ? board.terms.filter((t) => t.relevance !== null).map((t) => t.relevance!) : [];

  const rows: SignalRow[] = rest.map((t) => ({
    key: `${t.workspaceWide ? 'w' : 'c'}-${t.source}-${t.term}`,
    term: t.term,
    source: t.source,
    sourceLabel: SOURCE_LABEL[t.source] ?? t.source,
    relevance: t.relevance,
    daysSeen: t.timesSeen,
    velocity: withUnit(t.velocity, UNITS[t.source]?.velocity ?? null),
    volume: withUnit(t.volume, UNITS[t.source]?.volume ?? null),
    last: t.lastSeenAt.slice(0, 10),
    url: t.url,
    workspaceWide: t.workspaceWide,
  }));
  const bySource = SOURCE_ORDER.map((slug) => ({ slug, label: SOURCE_LABEL[slug], n: rows.filter((r) => r.source === slug).length })).filter((s) => s.n > 0);

  return (
    <>
      {board.scope === 'workspace' && (
        <div className="note">
          <Icon name="info" />
          <span>This database has no trend_signals.channel_id (migration 0046 not applied), so below is every channel’s signals, not {channelName}’s alone.</span>
        </div>
      )}

      <section className="card" aria-label="For this channel">
        <div className="card-h">
          <h2 className="h3">For this channel</h2>
          <span className="xs t3">
            relevance ≥ <span className="mono">{threshold.toFixed(2)}</span> · {relevant.length} of {board.terms.length}
          </span>
        </div>
        <div className="card-b col" style={{ gap: 12 }}>
          <p className="xs t3">
            Relevance is how close a term is to {channelName}’s premise, series and calendar topics (cosine similarity, −1 to 1). Change the threshold in Settings → Generation
            {thresholdNote ? ` — ${thresholdNote}` : ''}. Concept drafting and the connector’s trends_recent read these first; below-threshold signals are left out of drafting.
          </p>
          {!board.relevanceAvailable ? (
            <div className="empty">— Relevance is not scored on this database yet: migration 0051 (bundle 9) adds it. Until then every signal is under “Everything else”.</div>
          ) : relevant.length === 0 ? (
            <div className="empty">
              {scored === 0
                ? `— No signal has a relevance yet: ${relevanceNote?.detail ?? 'none of the captured signals has been scored (scoring starts with the first run after 0051)'}.`
                : `None of the ${scored} scored signals reaches ${threshold.toFixed(2)}. Scores this window run ${Math.min(...spread).toFixed(2)} to ${Math.max(...spread).toFixed(2)}.`}
            </div>
          ) : (
            <div className="kgrid ga-300">
              {relevant.map((t) => (
                <RelevantCard key={`${t.source}-${t.term}`} t={t} threshold={threshold} />
              ))}
            </div>
          )}
          {board.relevanceAvailable && scored > 0 && (
            <p className="xs t3 mono">
              {scored} scored · {unscored} not scored{unscored ? ` (${unscoredWhy})` : ''} · range {Math.min(...spread).toFixed(2)}–{Math.max(...spread).toFixed(2)}
            </p>
          )}
        </div>
      </section>

      <details className="card">
        <summary className="card-h" style={{ cursor: 'pointer', listStyle: 'none' }}>
          <h2 className="h3">Everything else ({rest.length})</h2>
          <span className="xs t3">below the threshold or not scored · last {board.windowDays} days · filter by source or search</span>
        </summary>
        <div className="card-b">
          {board.scope === 'channel' && board.workspaceWideInWindow > 0 && (
            <p className="xs t3" style={{ marginBottom: 10 }}>
              {board.workspaceWideInWindow} reading{board.workspaceWideInWindow === 1 ? '' : 's'} have no channel — captured before per-channel intake — and are marked workspace-wide.
            </p>
          )}
          {rows.length === 0 ? <div className="empty">Nothing else in the last {board.windowDays} days.</div> : <SignalList rows={rows} sources={bySource} unscoredWhy={unscoredWhy} />}
        </div>
      </details>
    </>
  );
}

function RelevantCard({ t, threshold }: { t: TrendTerm; threshold: number }) {
  const u = UNITS[t.source] ?? { velocity: null, volume: null };
  const vel = withUnit(t.velocity, u.velocity);
  const vol = withUnit(t.volume, u.volume);
  // The bar spans threshold → 1, so a card just over the line reads as just over it.
  const fill = Math.max(0.04, Math.min(1, (t.relevance! - threshold) / Math.max(0.0001, 1 - threshold)));
  return (
    <article className="card inset" style={{ minWidth: 0 }}>
      <div className="card-b col" style={{ gap: 10 }}>
        <div className="row sb" style={{ alignItems: 'flex-start', flexWrap: 'nowrap', gap: 10 }}>
          <p className="sm" style={{ fontWeight: 500, overflowWrap: 'anywhere', minWidth: 0 }}>
            {t.url ? (
              <a href={t.url} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecorationColor: 'var(--b3)' }}>
                {t.term}
              </a>
            ) : (
              t.term
            )}
          </p>
          <span className="chip" style={{ flex: 'none' }}>{SOURCE_LABEL[t.source] ?? t.source}</span>
        </div>
        <div className="col" style={{ gap: 4 }}>
          <div className="row sb xs">
            <span className="t3">Relevance</span>
            <span className="mono">{t.relevance!.toFixed(2)}</span>
          </div>
          <div className="bar" role="img" aria-label={`relevance ${t.relevance!.toFixed(2)} against a threshold of ${threshold.toFixed(2)}`}>
            <i style={{ width: `${Math.round(fill * 100)}%` }} />
          </div>
        </div>
        <dl className="xs" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, margin: 0 }}>
          <Stat label="Volume" value={vol} />
          <Stat label="Velocity" value={vel} />
          <Stat label="Days seen" value={String(t.timesSeen)} />
        </dl>
      </div>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt className="t3">{label}</dt>
      <dd className="mono" style={{ margin: 0, overflowWrap: 'anywhere' }}>{value ?? <span className="t3">—</span>}</dd>
    </div>
  );
}

function Shell({ children, sub, right }: { children: React.ReactNode; sub: React.ReactNode | null; right?: React.ReactNode }) {
  return (
    <main className="main">
      <header className="topbar">
        <div className="col" style={{ gap: 4, minWidth: 0 }}>
          <div className="crumb">
            <span>Pipeline</span>
            <span className="t4">/</span>
            <span>Trends</span>
          </div>
          <h1 className="h1">Trends</h1>
          {sub && <p className="sm t3 row" style={{ gap: 6 }}>{sub}</p>}
        </div>
        {right}
      </header>
      {children}
    </main>
  );
}
