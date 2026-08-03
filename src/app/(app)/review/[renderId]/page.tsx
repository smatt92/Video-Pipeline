import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ReviewScreen } from '@/components/review/screen';
import { serverClient } from '@/lib/db/server';
import { readReview } from '@/lib/review/read';
import { storage } from '@/lib/storage';

/**
 * Stage 8 — the QA gate, as a screen.
 *
 * ARCHITECTURE.md §0.2 makes human editorial judgement a compliance control rather than a
 * workflow step, and `enforce_review_pass` enforces it in the database. This is where that
 * judgement is actually made, so the screen's job is to put the things a person cannot see
 * by watching in front of them: whether the picture still lines up with the voice, whether
 * any clip is unnormalised, and whether the beat structure is one this channel has used
 * before.
 *
 * Everything media-shaped reaches the browser as a presigned URL signed here. No bytes pass
 * through this function (rule 2).
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ renderId: string }> }) {
  const { renderId } = await params;
  return { title: `Kiln — review ${renderId.slice(0, 8)}` };
}

export default async function ReviewPage({ params }: { params: Promise<{ renderId: string }> }) {
  const { renderId } = await params;
  const db = serverClient();

  let read;
  try {
    read = await readReview(db, renderId, storage());
  } catch (err) {
    // A storage driver that cannot be constructed — no bucket configured, no credentials —
    // must not take the screen down. The evidence panel is useful without the video, and
    // "the page is broken" and "storage is unconfigured" are different problems.
    return (
      <Broken
        headline="Object storage is not configured, so the render cannot be fetched."
        detail={err instanceof Error ? err.message : String(err)}
      />
    );
  }

  if (!read.ok) {
    if (read.detail.startsWith('No render')) notFound();
    return <Broken headline="This render could not be read." detail={read.detail} />;
  }

  const { render, timeline, voice, novelty, humanEditCount, current, history } = read.detail;

  // Per-shot clip URLs, presigned here for the same reason the render is. The composition
  // needs one per shot because it composes live rather than playing the flat rough cut.
  const driver = storage();
  const clipUrls: Record<string, string> = {};
  for (const span of timeline.spans) {
    if (!span.shot.assetKey) continue;
    try {
      const { url } = await driver.presignGet({ key: span.shot.assetKey, expiresIn: 3600 });
      clipUrls[span.shot.id] = url;
    } catch {
      // Left out rather than faked. The composition renders a labelled placeholder, which
      // is distinguishable from black — and black is what a dropped segment looks like.
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-8">
      <header className="mb-5 flex items-start gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <h2 className="truncate text-lg font-medium tracking-tight">
              {render.conceptTitle}
            </h2>
            <span className="font-mono text-3xs uppercase tracking-[0.09em]" style={{ color: 'var(--text-faint)' }}>
              {render.kind} · {render.variantLabel}
            </span>
          </div>
          <p className="mt-1 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
            {render.width}×{render.height} · picture {timeline.pictureDurationS.toFixed(2)}s ·
            voice {timeline.voDurationS.toFixed(2)}s
            {render.durationS !== null && ` · rendered ${render.durationS.toFixed(2)}s`}
          </p>
        </div>
        <Link href="/review" className="ml-auto shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
          ← queue
        </Link>
      </header>

      {/* The render's own duration against what its rows claim. `07-assemble` already
          refuses a mismatch and writes a failed render, so a ready render disagreeing here
          means the rows changed after it was made — a trim or a reorder — and the cut on
          disk is stale. */}
      {render.durationS !== null &&
        Math.abs(render.durationS - timeline.pictureDurationS) > 0.5 && (
          <div
            className="mb-5 rounded-md border px-4 py-3"
            style={{ background: 'var(--surface-1)', borderColor: 'var(--state-blocked)' }}
          >
            <p className="text-sm leading-relaxed">
              This render is {render.durationS.toFixed(2)}s but its shots now sum to{' '}
              {timeline.pictureDurationS.toFixed(2)}s. The rows changed after it was
              assembled — a trim or a reorder — so what plays below is the composed preview
              and the file on disk is something else. Re-run the rough cut before passing it.
            </p>
          </div>
        )}

      <ReviewScreen
        renderId={render.id}
        scriptId={render.scriptId}
        timeline={timeline}
        clipUrls={clipUrls}
        audioUrl={voice.audioUrl}
        words={voice.words}
        novelty={novelty}
        humanEditCount={humanEditCount}
        current={current}
      />

      {history.length > 1 && (
        <div className="mt-6">
          <h3 className="mb-2 font-mono text-3xs uppercase tracking-[0.09em]" style={{ color: 'var(--text-faint)' }}>
            Earlier decisions
          </h3>
          {history.slice(1).map((h) => (
            <div key={h.id} className="flex items-baseline gap-3 py-[3px] font-mono text-2xs" style={{ color: 'var(--text-muted)' }}>
              <span>{h.createdAt.slice(0, 19).replace('T', ' ')}</span>
              <span>{h.decision}</span>
              {h.notes && <span className="truncate">{h.notes}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Broken({ headline, detail }: { headline: string; detail: string }) {
  return (
    <div className="mx-auto w-full max-w-[900px] px-6 py-8">
      <p className="text-sm" style={{ color: 'var(--state-blocked)' }}>
        {headline}
      </p>
      <p className="mt-1 font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
        {detail}
      </p>
    </div>
  );
}
