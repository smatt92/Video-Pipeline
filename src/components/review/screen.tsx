'use client';

import { Player, type PlayerRef } from '@remotion/player';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { VIDEO_PAINT } from '@/styles/media-paint';
import { reorderShotsAction, setTrimAction, submitReviewAction, type ReviewState } from '@/lib/review/actions';
import {
  captionCues,
  moveShot,
  validateTrim,
  type Timeline,
  type TimelineShot,
} from '@/lib/review/timeline';
import { CANONICAL_FPS, ReviewComposition } from './composition';
import { KeyboardMap, SHORTCUTS } from './keyboard';
import { ShotStrip } from './shot-strip';
import { Waveform } from './waveform';

/**
 * The review screen.
 *
 * One client component owns the clock, the selection and the pending order, because those
 * three are the state every panel reads and splitting them across components produces the
 * classic two-playheads bug: the waveform scrubs, the player does not follow, and the
 * reviewer trusts whichever one they happened to be looking at.
 *
 * ── Everything is reachable from the keyboard ────────────────────────────────
 *
 * Not as an accessibility checkbox. Review is a scrub-heavy job — step a frame, mark an in
 * point, step back, compare — and doing that with a mouse is slow enough that people stop
 * doing it properly, which is how a cut with a half-second drift gets passed. The bindings
 * are the ones editors already have in their fingers (J/K/L, [ and ]) so they do not have
 * to be learned.
 *
 * ── The order on screen is not the order in the database until it is saved ───
 *
 * Dragging reorders locally and the canvas updates immediately, which is the point — you
 * can see the new order without a render. `Save order` is a separate, explicit action,
 * because renumbering shots invalidates every rough cut of that script and doing that on
 * every drag would be surprising.
 */

export interface ReviewScreenProps {
  renderId: string;
  scriptId: string;
  timeline: Timeline;
  clipUrls: Record<string, string>;
  audioUrl: string | null;
  words: { w: string; start: number; end: number }[];
  novelty: { sharedWith: number; unmeasured: boolean; structureHash: string };
  humanEditCount: number;
  current: { decision: string; notes: string | null; reshootShotIds: string[] } | null;
}

const IDLE: ReviewState = { status: 'idle' };
const FRAME_S = 1 / CANONICAL_FPS;

export function ReviewScreen(props: ReviewScreenProps) {
  const { renderId, scriptId, timeline, clipUrls, audioUrl, words } = props;

  const playerRef = useRef<PlayerRef>(null);
  const [currentTimeS, setCurrentTimeS] = useState(0);
  const [order, setOrder] = useState<string[]>(() => timeline.spans.map((s) => s.shot.id));
  const [selectedId, setSelectedId] = useState<string | null>(
    timeline.spans[0]?.shot.id ?? null,
  );
  const [reshootMarks, setReshootMarks] = useState<Set<string>>(
    () => new Set(props.current?.reshootShotIds ?? []),
  );
  const [showCaptions, setShowCaptions] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [message, setMessage] = useState<ReviewState>(IDLE);
  const [pending, startTransition] = useTransition();

  const shotsById = useMemo(
    () => new Map(timeline.spans.map((s) => [s.shot.id, s.shot])),
    [timeline],
  );

  // The locally reordered timeline. Recomputed from the same pure function the server uses,
  // so what the canvas plays and what the drift column reports cannot disagree.
  const localSpans = useMemo(() => {
    let cursor = 0;
    return order
      .map((id) => shotsById.get(id))
      .filter((s): s is TimelineShot => !!s)
      .map((shot) => {
        const startS = cursor;
        cursor += shot.effectiveDurationS;
        const original = timeline.spans.find((s) => s.shot.id === shot.id);
        return {
          shot,
          startS: round(startS),
          endS: round(cursor),
          voStartS: original?.voStartS ?? null,
          voEndS: original?.voEndS ?? null,
          driftS: original?.voStartS == null ? null : round(startS - original.voStartS),
        };
      });
  }, [order, shotsById, timeline]);

  const cues = useMemo(() => captionCues(words), [words]);
  const durationS = localSpans.length ? localSpans[localSpans.length - 1].endS : 0;
  const durationInFrames = Math.max(1, Math.round(durationS * CANONICAL_FPS));
  const dirty = order.join(',') !== timeline.spans.map((s) => s.shot.id).join(',');

  // ── The clock ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }) =>
      setCurrentTimeS(e.detail.frame / CANONICAL_FPS);
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, []);

  const seek = useCallback((seconds: number) => {
    const clamped = Math.max(0, Math.min(durationS, seconds));
    playerRef.current?.seekTo(Math.round(clamped * CANONICAL_FPS));
    setCurrentTimeS(clamped);
  }, [durationS]);

  const nudge = useCallback((delta: number) => seek(currentTimeS + delta), [currentTimeS, seek]);

  const selectBy = useCallback(
    (delta: number) => {
      if (localSpans.length === 0) return;
      const i = localSpans.findIndex((s) => s.shot.id === selectedId);
      const next = Math.max(0, Math.min(localSpans.length - 1, (i === -1 ? 0 : i) + delta));
      setSelectedId(localSpans[next].shot.id);
    },
    [localSpans, selectedId],
  );

  const moveSelected = useCallback(
    (delta: number) => {
      if (!selectedId) return;
      const i = order.indexOf(selectedId);
      if (i === -1) return;
      setOrder(moveShot([...shotsById.values()].map((s) => ({ ...s, idx: order.indexOf(s.id) })), selectedId, i + delta));
    },
    [order, selectedId, shotsById],
  );

  const setTrim = useCallback(
    (shotId: string, inS: number | null, outS: number | null) => {
      const shot = shotsById.get(shotId);
      if (!shot) return;

      // Validated on the client for the message, and again on the server for the truth.
      const check = validateTrim(shot, { inS, outS });
      if (!check.ok) {
        setMessage({ status: 'error', message: check.reason });
        return;
      }

      startTransition(async () => {
        setMessage(await setTrimAction(renderId, shotId, check.trimInS, check.trimOutS));
      });
    },
    [renderId, shotsById],
  );

  /** The playhead's offset into the selected shot — what an in/out point is set from. */
  const offsetIntoSelected = useCallback(() => {
    const span = localSpans.find((s) => s.shot.id === selectedId);
    if (!span) return null;
    const into = currentTimeS - span.startS;
    if (into < 0 || into > span.shot.effectiveDurationS) return null;
    return round(into + (span.shot.trimInS ?? 0));
  }, [currentTimeS, localSpans, selectedId]);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Never steal a key from a field. A reviewer typing "j" in the notes box must get a
      // "j", not a rewind.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey) return;

      const selected = selectedId ? shotsById.get(selectedId) : null;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          playerRef.current?.toggle();
          return;
        case 'k':
          e.preventDefault();
          playerRef.current?.pause();
          return;
        case 'j':
          e.preventDefault();
          nudge(-1);
          return;
        case 'l':
          e.preventDefault();
          nudge(1);
          return;
        case 'ArrowLeft':
          e.preventDefault();
          nudge(e.shiftKey ? -1 : -FRAME_S);
          return;
        case 'ArrowRight':
          e.preventDefault();
          nudge(e.shiftKey ? 1 : FRAME_S);
          return;
        case 'Home':
          e.preventDefault();
          seek(0);
          return;
        case 'End':
          e.preventDefault();
          seek(durationS);
          return;
        case 'ArrowUp':
          e.preventDefault();
          if (e.altKey) moveSelected(-1);
          else selectBy(-1);
          return;
        case 'ArrowDown':
          e.preventDefault();
          if (e.altKey) moveSelected(1);
          else selectBy(1);
          return;
        case 'Enter': {
          e.preventDefault();
          const span = localSpans.find((s) => s.shot.id === selectedId);
          if (span) seek(span.startS);
          return;
        }
        case '[': {
          e.preventDefault();
          if (!selected) return;
          const at = offsetIntoSelected();
          if (at === null) {
            setMessage({
              status: 'error',
              message: 'The playhead is not inside the selected shot. Press Enter to jump to it first.',
            });
            return;
          }
          setTrim(selected.id, at, selected.trimOutS ?? selected.durationS);
          return;
        }
        case ']': {
          e.preventDefault();
          if (!selected) return;
          const at = offsetIntoSelected();
          if (at === null) {
            setMessage({
              status: 'error',
              message: 'The playhead is not inside the selected shot. Press Enter to jump to it first.',
            });
            return;
          }
          setTrim(selected.id, selected.trimInS ?? 0, at);
          return;
        }
        case '\\':
          e.preventDefault();
          if (selected) setTrim(selected.id, null, null);
          return;
        case 'm':
          e.preventDefault();
          if (!selected) return;
          setReshootMarks((prev) => {
            const next = new Set(prev);
            if (next.has(selected.id)) next.delete(selected.id);
            else next.add(selected.id);
            return next;
          });
          return;
        case 'c':
          e.preventDefault();
          setShowCaptions((v) => !v);
          return;
        case '?':
          e.preventDefault();
          setShowHelp((v) => !v);
          return;
        default:
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    durationS,
    localSpans,
    moveSelected,
    nudge,
    offsetIntoSelected,
    seek,
    selectBy,
    selectedId,
    setTrim,
    shotsById,
  ]);

  const saveOrder = () => {
    startTransition(async () => {
      setMessage(await reorderShotsAction(renderId, scriptId, order));
    });
  };

  const submit = (decision: 'pass' | 'reshoot' | 'kill', notes: string) => {
    const form = new FormData();
    form.set('decision', decision);
    form.set('notes', notes);
    for (const id of reshootMarks) form.append('reshoot', id);
    startTransition(async () => {
      setMessage(await submitReviewAction(renderId, IDLE, form));
    });
  };

  return (
    <div className="grid gap-5" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 420px)' }}>
      <div className="flex min-w-0 flex-col gap-4">
        <div
          className="overflow-hidden rounded-md border"
          style={{ background: VIDEO_PAINT.background, borderColor: 'var(--border-subtle)' }}
        >
          {localSpans.length === 0 ? (
            <p className="px-4 py-10 text-center text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
              This render&apos;s script has no shots, so there is nothing to play.
            </p>
          ) : (
            <Player
              ref={playerRef}
              component={ReviewComposition}
              durationInFrames={durationInFrames}
              fps={CANONICAL_FPS}
              compositionWidth={1080}
              compositionHeight={1920}
              inputProps={{ spans: localSpans, clipUrls, cues, showCaptions }}
              style={{ width: '100%', aspectRatio: '9 / 16', maxHeight: '58vh', margin: '0 auto' }}
              controls
              acknowledgeRemotionLicense
            />
          )}
        </div>

        <Waveform
          audioUrl={audioUrl}
          cues={cues}
          currentTimeS={currentTimeS}
          onSeek={seek}
          shotBoundariesS={localSpans.map((s) => s.startS)}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <ShotStrip
          renderId={renderId}
          onRegenerated={setMessage}
          spans={localSpans}
          selectedId={selectedId}
          reshootMarks={reshootMarks}
          currentTimeS={currentTimeS}
          dirty={dirty}
          pending={pending}
          onSelect={setSelectedId}
          onSeek={seek}
          onReorder={setOrder}
          onSaveOrder={saveOrder}
          onSetTrim={setTrim}
          onToggleMark={(id) =>
            setReshootMarks((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
        />

        <DecisionPanel
          timeline={{ ...timeline, spans: localSpans }}
          novelty={props.novelty}
          humanEditCount={props.humanEditCount}
          current={props.current}
          marks={reshootMarks}
          dirty={dirty}
          pending={pending}
          onSubmit={submit}
        />

        {message.status !== 'idle' && message.message && (
          <p
            className="text-[12px] leading-relaxed"
            style={{ color: message.status === 'ok' ? 'var(--state-live)' : 'var(--state-blocked)' }}
          >
            {message.message}
          </p>
        )}

        <button
          type="button"
          onClick={() => setShowHelp((v) => !v)}
          className="self-start font-mono text-[10px] uppercase tracking-[0.09em]"
          style={{ color: 'var(--text-faint)' }}
        >
          {showHelp ? 'hide' : 'show'} keyboard map (?)
        </button>
        {showHelp && <KeyboardMap shortcuts={SHORTCUTS} />}
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════

function DecisionPanel({
  timeline,
  novelty,
  humanEditCount,
  current,
  marks,
  dirty,
  pending,
  onSubmit,
}: {
  timeline: Timeline;
  novelty: ReviewScreenProps['novelty'];
  humanEditCount: number;
  current: ReviewScreenProps['current'];
  marks: Set<string>;
  dirty: boolean;
  pending: boolean;
  onSubmit: (decision: 'pass' | 'reshoot' | 'kill', notes: string) => void;
}) {
  const [notes, setNotes] = useState(current?.notes ?? '');
  const drifted = timeline.spans.filter((s) => s.driftS !== null && Math.abs(s.driftS) > 0.25);
  const unnormalised = timeline.spans.filter((s) => s.shot.assetKey && !s.shot.normalised);
  const missing = timeline.spans.filter((s) => !s.shot.assetKey);

  return (
    <div
      className="rounded-md border"
      style={{ background: 'var(--surface-1)', borderColor: 'var(--border-subtle)' }}
    >
      <div
        className="border-b px-4 py-3 text-[13px] font-medium"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        Decision
      </div>

      <div className="flex flex-col gap-2 px-4 py-3">
        <Evidence
          label="Structure"
          tone={novelty.unmeasured ? 'review' : novelty.sharedWith === 0 ? 'live' : 'blocked'}
          value={
            novelty.unmeasured
              ? 'not measured'
              : novelty.sharedWith === 0
                ? 'novel'
                : `shared with ${novelty.sharedWith}`
          }
          help={
            novelty.unmeasured
              ? 'A Studio session stub hash is unique by construction, so uniqueness proves nothing. This records as not novel.'
              : novelty.sharedWith === 0
                ? 'No other script is built the same way.'
                : 'Other scripts share this beat structure. Not plagiarism, and not on its own a reason to refuse — but it is what the policy looks for.'
          }
        />
        <Evidence
          label="Human edits"
          tone={humanEditCount > 0 ? 'live' : 'review'}
          value={String(humanEditCount)}
          help="Frozen onto the review row when you decide, so later edits cannot change what you are recorded as having seen."
        />
        <Evidence
          label="Picture vs voice"
          tone={drifted.length === 0 ? 'live' : 'blocked'}
          value={drifted.length === 0 ? 'aligned' : `${timeline.worstDriftS}s at ${drifted.length}`}
          help={
            drifted.length === 0
              ? 'Every shot starts where its line starts.'
              : 'Shot durations are derived from word timings. A trim shortens the picture and not the voice, so from that shot on the words land over the wrong images — and the file still plays.'
          }
        />
        {(unnormalised.length > 0 || missing.length > 0) && (
          <Evidence
            label="Assets"
            tone="blocked"
            value={`${missing.length} missing · ${unnormalised.length} unnormalised`}
            help="An unnormalised clip cannot be concatenated: the rough cut will refuse it rather than produce a file that plays wrong."
          />
        )}
      </div>

      <div className="px-4 pb-3">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="What you saw, and why. This is the editorial record."
          className="w-full resize-y rounded-sm border px-2 py-[7px] text-[12.5px] leading-relaxed outline-none"
          style={{
            background: 'var(--surface-inset)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-primary)',
          }}
        />
      </div>

      {dirty && (
        <p className="px-4 pb-2 text-[11.5px]" style={{ color: 'var(--state-review)' }}>
          The shot order on screen is not saved. A decision recorded now is about the order in
          the database, not the one you are looking at.
        </p>
      )}

      <div className="flex gap-2 border-t px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          type="button"
          disabled={pending}
          onClick={() => onSubmit('pass', notes)}
          className="rounded-sm px-3 py-[7px] text-[12.5px] font-medium disabled:opacity-60"
          style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}
        >
          Pass
        </button>
        <button
          type="button"
          disabled={pending || marks.size === 0}
          onClick={() => onSubmit('reshoot', notes)}
          title={marks.size === 0 ? 'Mark the shots to reshoot first — press m on a shot.' : undefined}
          className="rounded-sm border px-3 py-[7px] text-[12.5px] disabled:opacity-40"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          Reshoot {marks.size > 0 && `(${marks.size})`}
        </button>
        {/* Neutral, with the severity on the label beside it rather than on the control.
            A button painted in a state colour reads as the state, and the rule that says so
            is right — but a Kill that looks exactly like Reshoot is its own hazard, so the
            warning goes where it can be read without being a paint job on a target. */}
        <span
          className="ml-auto self-center font-mono text-[10px] uppercase tracking-[0.09em]"
          style={{ color: 'var(--state-blocked)' }}
        >
          destructive
        </span>
        <button
          type="button"
          disabled={pending}
          onClick={() => onSubmit('kill', notes)}
          className="rounded-sm border px-3 py-[7px] text-[12.5px] disabled:opacity-60"
          style={{ borderColor: 'var(--border-strong)' }}
        >
          Kill
        </button>
      </div>

      {current && (
        <p
          className="border-t px-4 py-2 font-mono text-[10.5px]"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-faint)' }}
        >
          current decision: {current.decision}
        </p>
      )}
    </div>
  );
}

function Evidence({
  label,
  value,
  tone,
  help,
}: {
  label: string;
  value: string;
  tone: 'live' | 'review' | 'blocked';
  help: string;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-[110px] shrink-0 text-[12px]" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="font-mono text-[11.5px]" style={{ color: `var(--state-${tone})` }}>
        {value}
      </span>
      <span className="ml-auto max-w-[210px] text-right text-[10.5px] leading-snug" style={{ color: 'var(--text-faint)' }}>
        {help}
      </span>
    </div>
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
