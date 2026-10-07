import 'server-only';

import { serverClient, type Db } from '../db/server';
import { isChannelColumnMissing, signalUrl } from './recent';
import type { TrendSource } from './sources';

/**
 * What stage 1 has actually captured — the screen it has never had.
 *
 * ── What was and was not wrong here ──────────────────────────────────────────
 *
 * A sweep reported that "nothing in `src/` reads the trends table". That was produced by
 * grepping `from('trends')`, and the table is `trend_signals`. `concepts/run.ts:132` reads
 * it, so stage 1 does feed stage 2 and the chain is not broken.
 *
 * What is true, and is why this file exists: **no screen has ever shown it.** Intake runs,
 * writes rows, and the only evidence it worked is that stage 2 later produced concepts —
 * which conflates "no trends captured" with "capture is broken" with "the sources returned
 * nothing today", three states an operator has to tell apart and could not.
 *
 * ── The inverse test, applied up front ───────────────────────────────────────
 *
 * The obvious trap in a screen like this is a list that looks identical after one intake and
 * after fifty. A bare list of terms does exactly that: intake fifty times and you see the
 * same terms, because the interesting thing is not which terms exist but **how often, how
 * recently, and from where**.
 *
 * So nothing here returns a naked list. Every row carries the count and the window that
 * produced it, and the source panel exists specifically so that a source which has silently
 * stopped returning anything is visible as a source with an old `lastCapturedAt` rather than
 * as an absence nobody can attribute. `run.ts` dedups within a day keeping the later
 * reading, so `timesSeen` counts *days observed*, not raw fetches — stated because a count
 * whose unit is guessed is worse than no count.
 *
 * ── Why this aggregates in TypeScript and not in a view ──────────────────────
 *
 * The project prefers views, and this deliberately is not one — though the reason first
 * given was wrong and is worth correcting here rather than quietly. It said "this container
 * cannot run a migration", which was true of a container I had wrongly concluded had no
 * Postgres; a scratch cluster runs fine and every harness executes against it.
 *
 * The reason that survives is smaller and still holds: the row count is bounded by
 * construction — one row per term per source per day — and the aggregation is a group-by
 * over a bounded window, so a view would buy nothing a reader of this file cannot already
 * check by eye. If the window ever stops being bounded, that is the moment for the view.
 */

interface WindowRow {
  source: string;
  term: string;
  velocity: unknown;
  volume: unknown;
  captured_at: string;
  raw: unknown;
  relevance?: unknown;
}

/** How far back the board looks. Bounded so the aggregation below stays honest at any age. */
const WINDOW_DAYS = 30;

/**
 * Every source the pipeline knows about, listed so one that returns nothing still appears.
 *
 * Enumerated from the `TrendSource` union rather than from the rows, and typed against it so
 * adding a source to the union without adding it here is a compile error. A source panel
 * built from the rows would omit exactly the source that has stopped working, which is the
 * one you need to see — the same reason `v_pipeline_blockers` had to learn about blockers
 * that belong to no row.
 */
const SOURCES: { slug: TrendSource; label: string }[] = [
  { slug: 'youtube', label: 'YouTube' },
  { slug: 'reddit', label: 'Reddit' },
  { slug: 'google_trends', label: 'Google Trends' },
  { slug: 'wikipedia', label: 'Wikipedia' },
  { slug: 'hn', label: 'Hacker News' },
];

export interface SourceHealth {
  source: string;
  label: string;
  /** Rows captured in the window. Zero and "never" are different — see `lastCapturedAt`. */
  signals: number;
  distinctTerms: number;
  /** Null means this source has produced nothing in the window at all. Not zero: absent. */
  lastCapturedAt: string | null;
}

export interface TrendTerm {
  term: string;
  source: string;
  /** Days on which this term was observed, not raw fetches — `run.ts` dedups within a day. */
  timesSeen: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** From the most recent reading. Null is unknown, never zero. */
  velocity: number | null;
  volume: number | null;
  /** Relevance to this channel from the most recent reading (0051). Null = not scored — never 0. */
  relevance: number | null;
  /** The most recent reading's link, where the source gives one. */
  url: string | null;
  /**
   * True for rows with `channel_id is null`: captured before per-channel intake (0046), so
   * they belong to the whole workspace rather than this channel. Shown, and labelled.
   */
  workspaceWide: boolean;
}

export interface TrendBoard {
  windowDays: number;
  totalSignals: number;
  sources: SourceHealth[];
  terms: TrendTerm[];
  /** Null when nothing has ever been captured — distinct from "nothing captured lately". */
  everCapturedAt: string | null;
  /** 'workspace' = the database has no channel_id column (0046 not applied), so every row is shown. */
  scope: 'channel' | 'workspace';
  /** Of `totalSignals`, rows with no channel (captured before 0046), shown as workspace-wide. 0 when scope is 'workspace'. */
  workspaceWideInWindow: number;
  /** False when the database has no relevance column (0051 not pasted) — every relevance is then null for that reason. */
  relevanceAvailable: boolean;
}

export type TrendBoardResult =
  | { ok: true; board: TrendBoard }
  | { ok: false; error: string; hint: string };

/**
 * The board for one channel (0046: `trend_signals.channel_id`): its own rows, plus rows with
 * no channel — those predate per-channel intake and are labelled workspace-wide on each term
 * rather than silently mixed in or silently hidden. On a database without the column (0046
 * not applied) the board falls back to every row, unfiltered, and says so in `scope`.
 *
 * Two reads (this channel's, then the null-channel ones) rather than one `or()` filter, so
 * the fallback is a plain unfiltered read and nothing depends on PostgREST's `or` syntax.
 */
export async function readTrendBoard(channelId: string, client?: Db): Promise<TrendBoardResult> {
  const db = client ?? serverClient();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  // relevance (0051) is asked for and dropped from the select if the column is not there yet.
  let cols = 'source, term, velocity, volume, captured_at, raw, relevance';
  const windowedQ = () =>
    db
      .from('trend_signals')
      .select(cols)
      .gte('captured_at', since)
      .order('captured_at', { ascending: false }) as unknown as PromiseLike<{ data: WindowRow[] | null; error: { message: string } | null }> & {
      eq(c: string, v: string): PromiseLike<{ data: WindowRow[] | null; error: { message: string } | null }>;
      is(c: string, v: null): PromiseLike<{ data: WindowRow[] | null; error: { message: string } | null }>;
    };
  // Asked separately and deliberately: without it, an empty window is indistinguishable
  // from an empty table, and those send a person to different places — one to the source
  // configuration, the other to whether intake has ever run.
  const everQ = () => db.from('trend_signals').select('captured_at').order('captured_at', { ascending: false }).limit(1);

  let scope: TrendBoard['scope'] = 'channel';
  let relevanceAvailable = true;
  {
    const probe = await db.from('trend_signals').select('relevance').limit(1);
    if (probe.error && /relevance/.test(probe.error.message)) {
      relevanceAvailable = false;
      cols = 'source, term, velocity, volume, captured_at, raw';
    }
  }
  type Windowed = { data: WindowRow[] | null; error: { message: string } | null };
  type Row = WindowRow & { workspaceWide: boolean };
  let rows: Row[] = [];
  let everAt: string | null = null;

  const [mine, unassigned, everMine, everUnassigned] = await Promise.all([
    windowedQ().eq('channel_id', channelId),
    windowedQ().is('channel_id', null),
    everQ().eq('channel_id', channelId).maybeSingle(),
    everQ().is('channel_id', null).maybeSingle(),
  ]);
  let windowed: Windowed = mine;
  if (mine.error && isChannelColumnMissing(mine.error.message)) {
    scope = 'workspace';
    const [all, ever] = await Promise.all([windowedQ(), everQ().maybeSingle()]);
    windowed = all;
    rows = (all.data ?? []).map((r) => ({ ...r, workspaceWide: true }));
    everAt = ever.data?.captured_at ?? null;
  } else if (!mine.error && unassigned.error) {
    windowed = unassigned;
  } else if (!mine.error) {
    rows = [
      ...(mine.data ?? []).map((r) => ({ ...r, workspaceWide: false })),
      ...(unassigned.data ?? []).map((r) => ({ ...r, workspaceWide: true })),
    ].sort((a, b) => b.captured_at.localeCompare(a.captured_at));
    const stamps = [everMine.data?.captured_at, everUnassigned.data?.captured_at].filter((x): x is string => !!x).sort();
    everAt = stamps.at(-1) ?? null;
  }

  if (windowed.error) {
    return {
      ok: false,
      error: windowed.error.message,
      hint: /does not exist|schema cache/i.test(windowed.error.message)
        ? 'The trend_signals table is missing, so the migrations are not fully applied. Run `pnpm db:doctor`.'
        : 'The read failed. This is not an empty table — that returns totalSignals: 0.',
    };
  }

  // Per source. Built from the catalogue rather than from the rows, so a source that has
  // returned nothing appears as a row saying so instead of vanishing — which is the whole
  // point. A silent source that simply disappears from the screen is the failure this
  // panel exists to make impossible.
  const sources: SourceHealth[] = SOURCES.map((s) => {
    const mine = rows.filter((r) => r.source === s.slug);
    return {
      source: s.slug,
      label: s.label,
      signals: mine.length,
      distinctTerms: new Set(mine.map((r) => r.term)).size,
      lastCapturedAt: mine[0]?.captured_at ?? null,
    };
  });

  // Per term, per source. `numeric` crosses the wire as a string; `Number()` at this
  // boundary is a decision — velocity and volume are source-normalised small decimals well
  // inside a double, so the precision loss is accepted knowingly rather than incurred.
  const byTerm = new Map<string, TrendTerm>();
  for (const r of rows) {
    const key = `${r.workspaceWide ? 'w' : 'c'} ${r.source} ${r.term}`;
    const existing = byTerm.get(key);
    if (existing) {
      existing.timesSeen += 1;
      // Rows arrive newest-first, so the first one seen for a key is the latest reading and
      // the last one seen is the earliest.
      existing.firstSeenAt = r.captured_at;
      continue;
    }
    const velocity = r.velocity === null ? null : Number(r.velocity);
    const volume = r.volume === null ? null : Number(r.volume);
    const relevance = r.relevance === null || r.relevance === undefined ? null : Number(r.relevance);
    byTerm.set(key, {
      term: r.term,
      source: r.source,
      timesSeen: 1,
      firstSeenAt: r.captured_at,
      lastSeenAt: r.captured_at,
      velocity: Number.isFinite(velocity as number) ? velocity : null,
      volume: Number.isFinite(volume as number) ? volume : null,
      relevance: Number.isFinite(relevance as number) ? relevance : null,
      url: signalUrl(r.source, r.raw),
      workspaceWide: r.workspaceWide,
    });
  }

  const terms = [...byTerm.values()].sort(
    (a, b) => b.timesSeen - a.timesSeen || b.lastSeenAt.localeCompare(a.lastSeenAt),
  );

  return {
    ok: true,
    board: {
      windowDays: WINDOW_DAYS,
      totalSignals: rows.length,
      sources,
      terms,
      everCapturedAt: everAt,
      scope,
      workspaceWideInWindow: scope === 'channel' ? rows.filter((r) => r.workspaceWide).length : 0,
      relevanceAvailable,
    },
  };
}
