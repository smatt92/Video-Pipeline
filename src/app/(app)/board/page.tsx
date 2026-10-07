import Link from "next/link";
import { Suspense } from "react";

import { IntegrityAlert } from "@/components/pipeline/integrity-alert";
import { LimitsStrip } from "@/components/pipeline/limits-strip";
import { PathStrip } from "@/components/pipeline/path-strip";
import { Hint } from "@/components/shell/hint";
import { StateGlyph } from "@/components/shell/state-glyph";
import { currentChannel } from "@/lib/channels/active";
import type { VideoState } from "@/lib/fixtures/pipeline";
import { deferralState, inertBecause } from "@/lib/onboarding/deferred";
import { readLimits } from "@/lib/pipeline/limits";
import { readPath } from "@/lib/pipeline/path";
import {
  readBoard,
  type BoardRow,
  type ConceptState,
} from "@/lib/pipeline/board";

/**
 * The pipeline board — from the database.
 *
 * Calm density: answer "is everything okay?" first, let everything else wait a layer down.
 * Sorted so what needs a human is at the top.
 *
 * ── Three outcomes, never two ────────────────────────────────────────────────
 *
 * Rows, empty, or broken. The distinction between the last two is why this was rewritten
 * off fixtures rather than merely pointed at a different source: a blank board that could
 * mean "no concepts yet" or "the query failed" makes the second case invisible until
 * somebody independently suspects it. The empty state says what would put something here
 * and names anything deferred that will stop it; the broken state says what failed.
 *
 * `src/lib/fixtures/pipeline.ts` stays — `/studio` and the design-system screens render it
 * and it is Gate 1's artefact. Nothing here reads it except the glyph's state vocabulary,
 * which is a design-system type rather than data.
 */

const MAX_W = "mx-auto w-full max-w-[1400px]";

const STATE_LABEL: Record<ConceptState, string> = {
  draft: "Draft",
  scripted: "Scripted",
  shot_listed: "Shot-listed",
  generating: "Generating",
  needs_review: "Needs review",
  blocked: "Blocked",
  stalled: "Stalled",
  ready: "Ready",
  published: "Published",
};

/**
 * Pipeline states are finer-grained than the glyph's vocabulary, on purpose: "scripted"
 * and "shot-listed" are different places to be and the same colour of dot. The mapping
 * lives here rather than widening the design system for a distinction only this screen
 * makes.
 */
const GLYPH: Record<ConceptState, VideoState> = {
  draft: "drafting",
  scripted: "drafting",
  shot_listed: "drafting",
  generating: "generating",
  needs_review: "needs_review",
  blocked: "blocked",
  // The same glyph as blocked, and that is deliberate. To the eye scanning for "is
  // everything okay?", stalled and blocked are the same answer — something needs you. The
  // *label* and the reason underneath are where they differ, because what you do about them
  // differs: blocked means read the error, stalled means fix the named configuration.
  stalled: "blocked",
  ready: "ready",
  published: "live",
};

// Attention first, archive last.
const STATE_ORDER: ConceptState[] = [
  "blocked",
  // Second, above needs_review. A stalled concept is not waiting for a decision — it is
  // waiting for something nobody has been told about, and it will wait for ever.
  "stalled",
  "needs_review",
  "generating",
  "shot_listed",
  "scripted",
  "draft",
  "ready",
  "published",
];

const GRID = "1fr 130px 150px 120px";
/** Below this the four columns overlap; the board scrolls inside itself instead of the page. */
const MIN_W = 560;

const rowStyle = {
  gridTemplateColumns: GRID,
  minWidth: MIN_W,
  borderColor: "var(--b1)",
  transitionDuration: "var(--d1)",
} as const;

function formatInr(n: number): string {
  return `₹${n.toFixed(2)}`;
}

function RowShell({
  opens,
  href,
  children,
}: {
  opens: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return opens ? (
    <Link
      href={href}
      className="grid items-center gap-5 border-b px-5 py-3 transition-colors"
      style={rowStyle}
    >
      {children}
    </Link>
  ) : (
    <div
      className="grid items-center gap-5 border-b px-5 py-3"
      style={rowStyle}
      title="On another channel — switch channel in the sidebar to open it."
    >
      {children}
    </div>
  );
}

function Row({
  row,
  activeChannelId,
}: {
  row: BoardRow;
  activeChannelId: string | null;
}) {
  // The board is workspace-wide and /concepts/[id] opens only the active channel's concepts,
  // so a row of another channel is not a link — a link that 404s is a dead end with a URL.
  const opens = row.channelId === activeChannelId;
  return (
    <RowShell opens={opens} href={`/concepts/${row.id}`}>
      <span className="truncate text-sm">{row.title}</span>

      <span
        className="flex items-center gap-2 text-xs"
        style={{ color: "var(--t2)" }}
      >
        <StateGlyph state={GLYPH[row.state]} size={8} />
        {/* The reason, on the row, not behind a click. A stalled concept is one whose
            problem is invisible by construction — putting the explanation one interaction
            away would preserve exactly the silence this state exists to break. */}
        {row.blocker ? (
          <Hint content={row.blocker}>
            <span style={{ borderBottom: "1px dotted var(--b3)" }}>
              {STATE_LABEL[row.state]}
            </span>
          </Hint>
        ) : (
          STATE_LABEL[row.state]
        )}
      </span>

      <span className="font-mono text-2xs" style={{ color: "var(--t3)" }}>
        {row.scripts} script · {row.shots} shot · {row.generations} gen
      </span>

      <span
        className="text-right font-mono text-xs"
        style={{ color: "var(--t3)" }}
      >
        {row.costInr === null ? (
          <Hint content="No priced call has been recorded against this concept. Not zero — unknown. A submit that cannot be priced refuses rather than proceeding uncosted.">
            <span style={{ color: "var(--t3)" }}>—</span>
          </Hint>
        ) : (
          <>
            {formatInr(row.costInr)}
            {row.unpricedCalls > 0 && (
              <Hint content="Some calls against this concept could not be priced, so this total is knowingly incomplete rather than wrong.">
                <span style={{ color: "var(--t3)" }}>
                  {" "}
                  ·{row.unpricedCalls}?
                </span>
              </Hint>
            )}
          </>
        )}
      </span>
    </RowShell>
  );
}

async function Board() {
  const [result, deferrals, limits, path, channels] = await Promise.all([
    readBoard(),
    deferralState(),
    readLimits(),
    readPath(),
    currentChannel(),
  ]);

  if (!result.ok) {
    return (
      <div className={`${MAX_W} px-5 py-10`}>
        <div
          className="rounded-sm border px-4 py-3 text-sm leading-relaxed"
          style={{
            borderColor: "var(--b3)",
            background: "var(--in)",
            color: "var(--rev)",
          }}
          data-board="error"
        >
          <strong className="font-medium">This board could not be read.</strong>
          <p className="mt-1" style={{ color: "var(--t2)" }}>
            {result.hint}
          </p>
          <p className="mt-2 font-mono text-xs" style={{ color: "var(--t3)" }}>
            {result.error}
          </p>
          <p className="mt-2" style={{ color: "var(--t3)" }}>
            This is <em>not</em> an empty database — that renders a different
            message saying so. If you are seeing this, the read itself failed.
          </p>
        </div>
      </div>
    );
  }

  if (result.rows.length === 0) {
    const videoInert = inertBecause(deferrals, "generation");
    const audioInert = inertBecause(deferrals, "voice");

    return (
      <div className={`${MAX_W} px-5 py-10`} data-board="empty">
        <p className="text-sm" style={{ color: "var(--t2)" }}>
          No concepts yet. The database is reachable and this query succeeded —
          there is simply nothing in it.
        </p>
        <p
          className="mt-2 max-w-[62ch] text-sm leading-relaxed"
          style={{ color: "var(--t3)" }}
        >
          A concept appears here as soon as one exists. Stage 3 gives it a
          script, stage 4 a shotlist, stage 5 generations — each moves the row
          up this list without anything else being done to it.
        </p>

        {/*
          Rendered on the empty board too, and deliberately. Credits expire about 90 days
          after purchase whether or not a single concept exists, and nothing is billed at
          the moment they evaporate — so an empty pipeline is exactly when the clock is
          easiest to forget and most expensive to miss.
        */}
        {limits.ok && (
          <div className="mt-6">
            <LimitsStrip
              limits={limits.limits}
              quotas={limits.quotas}
              credits={limits.credits}
              noPurchases={limits.noPurchases}
            />
          </div>
        )}

        {(videoInert || audioInert) && (
          <div
            className="mt-5 max-w-[62ch] rounded-sm border px-3 py-2 text-xs leading-relaxed"
            style={{
              borderColor: "var(--b3)",
              background: "var(--in)",
              color: "var(--t3)",
            }}
          >
            <strong className="font-medium" style={{ color: "var(--rev)" }}>
              Some of that will not happen yet.
            </strong>
            {videoInert && <p className="mt-1">{videoInert}</p>}
            {audioInert && <p className="mt-1">{audioInert}</p>}
          </div>
        )}
      </div>
    );
  }

  const sorted = [...result.rows].sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state),
  );

  const priced = result.rows.filter((r) => r.costInr !== null);
  const total = priced.reduce((sum, r) => sum + (r.costInr ?? 0), 0);
  const unpriced = result.rows.length - priced.length;

  return (
    <>
      {/*
        One banner, not one per row.
        A workspace-level blocker is identical on every concept, so rendering it in each row
        turns one problem into a hundred and sends the reader to a shot list to fix a
        Settings problem. It sits above everything because until it clears, nothing below it
        can generate — which `v_pipeline_blockers` could not say at all before 0028: it
        returned null, meaning nothing was stopping these scripts, while stage 5 would have
        refused every one of them.
      */}
      {result.workspaceBlocker && (
        <div
          className="border-b px-5 py-3 text-sm"
          style={{ borderColor: "var(--blk)", background: "var(--blk-wash)" }}
        >
          <div className={MAX_W}>
            <span className="font-medium">Nothing here can generate yet.</span>{" "}
            <span style={{ color: "var(--t3)" }}>
              {result.workspaceBlocker}
            </span>{" "}
            <Link href="/settings/integrations" className="underline">
              Settings → Integrations
            </Link>
          </div>
        </div>
      )}

      <div className="border-b" style={{ borderColor: "var(--b1)" }}>
        <div
          className={`${MAX_W} flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4`}
        >
          {STATE_ORDER.map((state) => ({
            state,
            n: result.rows.filter((r) => r.state === state).length,
          }))
            .filter((c) => c.n > 0)
            .map(({ state, n }) => (
              <div key={state} className="flex items-center gap-2">
                <StateGlyph state={GLYPH[state]} size={8} />
                <span className="text-xs" style={{ color: "var(--t2)" }}>
                  {n} {STATE_LABEL[state].toLowerCase()}
                </span>
              </div>
            ))}

          <div
            className="ml-auto flex items-baseline gap-2 font-mono text-xs"
            style={{ color: "var(--t3)" }}
          >
            <span style={{ color: "var(--t1)" }}>
              {priced.length === 0 ? "—" : formatInr(total)}
            </span>
            <span>
              {priced.length === 0
                ? "nothing priced yet"
                : `across ${priced.length}`}
            </span>
            {result.truncated && (
              <Hint
                content={`Only the most recent ${result.limit} concepts are read, so both the state counts and this total are floors rather than totals. A capped list that renders its own length reports the same number whatever is behind it.`}
              >
                <span style={{ color: "var(--rev)" }}>
                  · capped at {result.limit}
                </span>
              </Hint>
            )}
            {unpriced > 0 && (
              <Hint content="These have no priced call recorded, so their cost is genuinely unknown — not zero. A total that silently excludes rows is the kind of number that gets quoted.">
                <span style={{ color: "var(--t3)" }}>
                  · {unpriced} unpriced
                </span>
              </Hint>
            )}
          </div>
        </div>
      </div>

      {/*
        Above the concept list, below the state counts. These are two limits you hit
        unexpectedly and then spend an hour diagnosing, and the 90-day credit clock runs
        whether or not anything is in the pipeline — so it belongs on the screen opened
        daily rather than three clicks into Settings.
      */}
      {limits.ok ? (
        <div className={`${MAX_W} px-5 py-4`}>
          <LimitsStrip
            limits={limits.limits}
            quotas={limits.quotas}
            credits={limits.credits}
            noPurchases={limits.noPurchases}
          />
        </div>
      ) : (
        <div className={`${MAX_W} px-5 py-4`}>
          <div
            className="rounded-md border px-4 py-3 text-sm"
            style={{ borderColor: "var(--blk)", background: "var(--blk-wash)" }}
          >
            <div>Limits and credits could not be read.</div>
            <div className="mt-1" style={{ color: "var(--t3)" }}>
              {limits.hint}
            </div>
            <div
              className="mt-1 font-mono text-2xs"
              style={{ color: "var(--t3)" }}
            >
              {limits.error}
            </div>
          </div>
        </div>
      )}

      {/*
        Where each concept is on the path.
        The board above answers "is everything okay?" across concepts; this answers "where
        am I?" for one, which nothing has ever told a first-time user. Capped at four:
        beyond that it stops being an orientation device and becomes a second board.
      */}
      {path.ok && path.positions.length > 0 && (
        <div className={`${MAX_W} space-y-2 px-5 py-4`}>
          {path.positions.slice(0, 4).map((p) => (
            <PathStrip key={p.conceptId} position={p} />
          ))}
          {path.positions.length > 4 && (
            <p className="text-2xs" style={{ color: "var(--t3)" }}>
              {path.positions.length - 4} more below, in the list.
            </p>
          )}
        </div>
      )}

      <div className="tscroll">
        <div style={{ background: "var(--in)" }}>
          <div
            className={`${MAX_W} grid gap-5 border-b px-5 py-2 font-mono text-3xs uppercase tracking-[0.09em]`}
            style={{
              gridTemplateColumns: GRID,
              minWidth: MIN_W,
              borderColor: "var(--b1)",
              color: "var(--t3)",
            }}
          >
            <span>Concept</span>
            <span>State</span>
            <span>Rows</span>
            <span className="text-right">Cost</span>
          </div>
        </div>

        <div className={MAX_W}>
          {sorted.map((row) => (
            <Row
              key={row.id}
              row={row}
              activeChannelId={channels.active?.id ?? null}
            />
          ))}
        </div>
      </div>
    </>
  );
}

export default function PipelineBoard() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b" style={{ borderColor: "var(--b1)" }}>
        <div
          className={`${MAX_W} flex items-center gap-3 px-5`}
          style={{ height: "var(--topbar-height)" }}
        >
          <h1 className="h2">Script board</h1>

          {/* Nothing at all when both integrity counts are zero, which is every ordinary
              day. See the component for the third state. */}
          <Suspense fallback={null}>
            <IntegrityAlert />
          </Suspense>

          <div className="ml-auto flex items-center gap-3">
            <Link href="/concepts" className="btn pri sm">
              New concept
            </Link>
          </div>
        </div>
      </header>

      {/* Suspended so a slow database delays the rows rather than the shell — the top bar
          and the deferral banner stay legible while this resolves. */}
      <Suspense
        fallback={
          <div
            className={`${MAX_W} px-5 py-10 text-sm`}
            style={{ color: "var(--t3)" }}
          >
            Reading the pipeline…
          </div>
        }
      >
        <Board />
      </Suspense>
    </div>
  );
}

// Read on every request. A cached board shows a generation as queued after it finished.
export const dynamic = "force-dynamic";
