import Link from 'next/link';

import { CutControls, RegenerateButton } from '@/components/bureau/cut-controls';
import { LiveRefresh, LiveStatus } from '@/components/bureau/live-status';
import { RecutForm } from '@/components/bureau/recut-form';
import { ObjectSheetCard } from '@/components/bureau/object-sheet-card';
import { RedrawPicture } from '@/components/bureau/redraw-picture';
import { ScreenHeader } from '@/components/shell/screen-header';
import { inr, Note } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Player } from '@/components/ui/player';
import { Basis, EpisodeStatePill, Gate } from '@/components/ui/tags';
import { isVideoRoute } from '@/lib/bureau/estimate';
import { FORMAT_INFO, MOTION_INFO, MotionLevelSchema, VisualFormatSchema, type FormatSource, type VisualFormat } from '@/lib/bureau/formats';
import { heroObjectsOf } from '@/lib/bureau/engineered';
import type { LockedObject } from '@/lib/bureau/object-sheets';
import { channelGeneration, episodeClips } from '@/lib/bureau/overlay-only';
import { recutOptions } from '@/lib/bureau/recut';
import { pictureSpansFor } from '@/lib/bureau/episode-steps';
import { pictureTuning } from '@/lib/settings/tuning';
import { redrawInFlight, redrawRefusal, redrawsOf } from '@/lib/bureau/redraw-state';
import { stillsByPart } from '@/lib/bureau/stills';
import { isRunning } from '@/lib/bureau/running';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { titleOf } from '@/lib/screens/common';
import { storage } from '@/lib/storage';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cuts' };

type Clip = { shot_idx: number; passed: boolean; reasons: string[]; action: string };

const ROUTE_LABEL: Record<string, string> = { overlay: 'overlay', still: 'scene still', picture_clip: 'picture clip', character_beat: 'character beat', money_shot: 'money shot' };

/**
 * Cuts (canvas: Cuts, Cuts-m) — the second gate. The composite in the 9:16 player with a scrub
 * segmented by shot, the shot list with the route of each and Regenerate where a re-roll exists
 * (video routes), each picture of an illustrated shot with Redraw (redraw.ts; the cut is held
 * while one is redrawn), QC against what was
 * actually measured, and Approve / Send back. One cut at a time; `?id=` picks another.
 */
export default async function CutsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const channel = await requireChannel();
  const db = serverClient();
  const [{ data: eps }, readiness] = await Promise.all([
    db
      .from('episodes')
      .select('id, slot_id, status, status_detail, script_id, final_render_id, qc, estimate_inr, voice_detail, updated_at, brief_id, kind')
      .eq('channel_id', channel.id)
      .in('status', ['awaiting_cut', 'cut_rejected', 'qc', 'assembling'])
      .order('updated_at', { ascending: false }),
    channelGeneration(db, channel.id),
  ]);
  const list = eps ?? [];
  const briefIds = list.map((e) => e.brief_id);
  const briefs = briefIds.length ? (await db.from('briefs').select('*').in('id', briefIds)).data ?? [] : [];
  const briefOf = new Map(briefs.map((b) => [b.id, b]));

  const header = (sub: string, extra?: React.ReactNode) => (
    <ScreenHeader channel={channel} crumb="Cuts" title={extra ?? 'Cuts'} mobileTitle="Cuts" sub={sub} />
  );

  if (list.length === 0) {
    return (
      <main className="main">
        {header('Nothing waiting')}
        <div className="empty" style={{ padding: 40 }}>
          <span style={{ color: 'var(--t2)', fontWeight: 500 }}>Nothing to cut</span>
          <span>Cuts appear here after QC passes. You watch every one before it can be scheduled.</span>
          <Link className="btn sm" href="/bureau/board" style={{ marginTop: 8 }}>
            Open board
          </Link>
        </div>
      </main>
    );
  }

  const e = list.find((x) => x.id === id) ?? list.find((x) => x.status === 'awaiting_cut') ?? list[0]!;
  const brief = briefOf.get(e.brief_id);
  // The reads for the cut on screen depend only on the episode row, so they start together
  // here and are awaited where they are used — one after another they were most of the wait
  // before this screen could paint.
  const recutP = e.status === 'cut_rejected' ? recutOptions(db, channel.id, e) : Promise.resolve(null);
  const mediaP = (async () => {
    if (!e.final_render_id) return { url: null as string | null, dims: null as { w: number; h: number; dur: number | null } | null };
    const { data: r } = await db.from('renders').select('asset_id, width, height, duration_s').eq('id', e.final_render_id).maybeSingle();
    const dims = r ? { w: r.width, h: r.height, dur: r.duration_s === null ? null : Number(r.duration_s) } : null;
    const { data: a } = r?.asset_id ? await db.from('assets').select('storage_key').eq('id', r.asset_id).maybeSingle() : { data: null };
    const url = a ? await storage().presignGet({ key: a.storage_key, expiresIn: 3600 }).then((p) => p.url).catch(() => null) : null;
    return { url, dims };
  })();
  const shotsP = e.script_id
    ? db.from('shots').select('id, idx, render_route, duration_s, effective_duration_s, status, description').eq('script_id', e.script_id).order('idx').then((r) => r.data ?? [])
    : Promise.resolve([]);
  // v_episode_spend coalesces to 0, so an episode with no script (no ledger row can attach)
  // would read as free. Absent is not zero: without a script the figure is withheld.
  const spendP = e.script_id ? db.from('v_episode_spend').select('spent_inr, unpriced_rows').eq('episode_id', e.id).maybeSingle().then((r) => r.data) : Promise.resolve(null);
  const genP = episodeClips(db, e);
  const tuningP = e.status === 'awaiting_cut' && e.script_id ? pictureTuning(db, channel.id) : null;
  // Started early, awaited later: a rejection before its await must not count as unhandled.
  for (const p of [mediaP, shotsP, spendP, genP, tuningP]) if (p) Promise.resolve(p).catch(() => undefined);
  const recut = await recutP;
  // The format the planner recorded (formats.ts) — read back from the plan, never re-derived here.
  const storedFormat = ((e.qc ?? {}) as { plan?: { format?: { format?: unknown; source?: unknown } } }).plan?.format;
  const parsedFormat = VisualFormatSchema.safeParse(storedFormat?.format);
  const planFormat: { format: VisualFormat; source: FormatSource } | null = parsedFormat.success ? { format: parsedFormat.data, source: (storedFormat?.source as FormatSource) ?? 'default' } : null;
  // Cartoon characters: why it fell back, and who was drawn in / left out of each picture (picture-cast.ts).
  const planObj = ((e.qc ?? {}) as { plan?: { format?: { requested?: string; fallback_reason?: string }; cast?: { idx: number; part: number; drawn: string[]; excluded: { slug: string; reason: string }[] }[] } }).plan;
  const castFallback = planObj?.format?.requested === 'characters' ? planObj.format.fallback_reason ?? 'no locked character sheets' : null;
  const engineeredFallback = planObj?.format?.requested === 'engineered' ? planObj.format.fallback_reason ?? 'the 3D explainer was unavailable' : null;
  // 3D explainer (0052): the motion the plan used, and each hero object's locked sheet.
  const ePlan = (planObj ?? {}) as { motion?: { motion?: unknown }; objects?: LockedObject[]; objects_missing?: { tag: string; reason: string }[] };
  const planMotion = MotionLevelSchema.safeParse(ePlan.motion?.motion);
  const heroCards =
    planFormat?.format === 'engineered'
      ? await Promise.all(
          heroObjectsOf((brief as { hero_objects?: unknown } | undefined)?.hero_objects).map(async (o) => {
            const locked = (ePlan.objects ?? []).find((x) => x.tag === o.tag);
            return {
              tag: o.tag,
              name: o.name,
              url: locked ? await storage().presignGet({ key: locked.storage_key, expiresIn: 3600 }).then((p) => p.url).catch(() => null) : null,
              missing: (ePlan.objects_missing ?? []).find((x) => x.tag === o.tag)?.reason ?? null,
            };
          }),
        )
      : [];
  const castByShot = new Map<number, { part: number; drawn: string[]; excluded: { slug: string; reason: string }[] }[]>();
  for (const c of planObj?.cast ?? []) castByShot.set(c.idx, [...(castByShot.get(c.idx) ?? []), c]);
  const [{ url, dims }, shotRows] = await Promise.all([mediaP, shotsP]);
  const shots = shotRows.map((s) => ({ ...s, dur: Number(s.effective_duration_s ?? s.duration_s) }));
  // Each picture of an illustrated shot, newest per part, as a presigned GET (rule 2: URLs
  // through Vercel, never bytes) — shown with Redraw while the cut awaits a decision.
  const redrawing = redrawInFlight(e.qc);
  const holdCut = redrawRefusal(e.qc);
  const lastRedraw = redrawsOf(e.qc).at(-1) ?? null;
  const pictures = new Map<string, { part: number; url: string | null }[]>();
  if (e.status === 'awaiting_cut' && e.script_id && shots.some((s) => s.render_route === 'still')) {
    const stillShots = shots.filter((x) => x.render_route === 'still');
    const [spans, haves] = await Promise.all([pictureSpansFor(db, e.script_id, await tuningP!), Promise.all(stillShots.map((s) => stillsByPart(db, s.id)))]);
    const rows = await Promise.all(
      stillShots.map(async (s, i) => {
        const have = haves[i]!;
        const n = Math.max(1, spans.get(s.id)?.length ?? 1, ...[...have.keys()].map((k) => k + 1));
        return [
          s.id,
          await Promise.all(
            [...Array(n).keys()].map(async (part) => {
              const key = have.get(part)?.storageKey;
              return { part, url: key ? await storage().presignGet({ key, expiresIn: 3600 }).then((p) => p.url).catch(() => null) : null };
            }),
          ),
        ] as const;
      }),
    );
    for (const [k, v] of rows) pictures.set(k, v);
  }
  const spend = await spendP;
  const qcObj = (e.qc ?? {}) as { clips?: Record<string, Clip>; loudness_lufs?: number | null; loudness_target_lufs?: number | null };
  const clips = Object.values(qcObj.clips ?? {});
  const lufs = qcObj.loudness_lufs ?? null;
  const gen = await genP;
  const voice = e.voice_detail as { unaligned?: number | null; lines?: number; overflow?: boolean; overflow_reason?: string; respoken_lines?: number } | null;
  const unaligned = voice?.unaligned ?? null;
  const totalS = shots.reduce((n, s) => n + s.dur, 0);
  const policyStatus = (brief?.policy as { status?: string } | null)?.status ?? null;
  const routes = [...new Set(shots.map((s) => s.render_route ?? 'overlay'))];

  type QcRow = { label: string; state: 'pass' | 'fail' | 'unknown'; value: string };
  const qcRows: QcRow[] = [
    { label: 'Loudness', state: lufs === null ? 'unknown' : Math.abs(lufs - (qcObj.loudness_target_lufs ?? -14)) <= 1.5 ? 'pass' : 'fail', value: lufs === null ? '— not measured' : `${lufs.toFixed(1)} LUFS` },
    {
      label: e.kind === 'long_form' ? 'Duration' : 'Duration ≤ 60 s',
      state: dims?.dur == null && !totalS ? 'unknown' : e.kind === 'long_form' || (dims?.dur ?? totalS) <= 60 ? 'pass' : 'fail',
      value: dims?.dur != null ? `${dims.dur.toFixed(1)} s` : totalS ? `${totalS.toFixed(1)} s planned` : '—',
    },
    {
      label: 'Clips pass QC',
      state: clips.length === 0 ? 'unknown' : clips.every((c) => c.passed) ? 'pass' : 'fail',
      value: clips.length === 0 ? '— no generated clip' : `${clips.filter((c) => c.passed).length}/${clips.length}`,
    },
    { label: 'Policy lint', state: policyStatus === 'pass' ? 'pass' : policyStatus ? 'fail' : 'unknown', value: policyStatus ?? '—' },
    {
      label: 'Voice aligned to script',
      state: unaligned === null ? 'unknown' : unaligned === 0 ? 'pass' : 'fail',
      value: unaligned === null ? '—' : `${(voice?.lines ?? 0) - unaligned}/${voice?.lines ?? '—'}`,
    },
  ];
  const measured = qcRows.filter((r) => r.state !== 'unknown');
  const passed = measured.filter((r) => r.state === 'pass').length;

  return (
    <main className="main">
      <LiveRefresh active={list.some((x) => isRunning(x.status)) || !!redrawing} />
      <header className="topbar desk-only">
        <div className="col" style={{ gap: 0, minWidth: 0 }}>
          <div className="crumb">
            <span className="chm" aria-hidden="true" />
            <span>{channel.name}</span>
            <span className="t4">/</span>
            <span>Cuts</span>
            <span className="t4">/</span>
            <span className="mono">{e.slot_id ?? 'bank'}</span>
          </div>
          <div className="row" style={{ gap: 12 }}>
            <h1 className="h1">{brief ? titleOf(brief.premise) : e.slot_id}</h1>
            <EpisodeStatePill status={e.status} />
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="mono sm t3">
            {dims?.dur != null ? `${dims.dur.toFixed(1)} s` : totalS ? `${totalS.toFixed(1)} s planned` : 'no render yet'} ·{' '}
            {spend?.spent_inr == null ? '— nothing ledgered' : `${inr(Number(spend.spent_inr))} spent`}
          </span>
          {spend?.spent_inr != null && <Basis kind="est" short />}
        </div>
      </header>
      <div className="mob-only">
        <ScreenHeader channel={channel} crumb="Cuts" title="Cuts" sub={`${e.slot_id ?? 'bank'} · ${brief ? titleOf(brief.premise) : ''}`} />
      </div>

      {list.length > 1 && (
        <nav className="row" aria-label="Cuts waiting" style={{ gap: 6 }}>
          {list.map((x) => (
            <Link key={x.id} href={`/bureau/cuts?id=${x.id}`} className={`chip${x.id === e.id ? ' on' : ''}`} aria-current={x.id === e.id ? 'true' : undefined}>
              <span className="mono">{x.slot_id ?? 'bank'}</span> · {x.status.replace('_', ' ')}
            </Link>
          ))}
        </nav>
      )}

      {castFallback && <Note>Cartoon characters was picked, but this episode was made as Illustrated: {castFallback}.</Note>}
      {engineeredFallback && <Note>3D explainer was picked, but this episode was made as Illustrated: {engineeredFallback}.</Note>}
      {readiness.summary && planFormat?.format === 'cinematic' && <Note>{readiness.summary} Those shots are drawn as pictures or diagrams instead; nothing is spent on video.</Note>}

      <div className="split">
        <div className="cutcol">
          <Player src={url} label={e.slot_id ?? 'cut'} shots={shots.map((s) => s.dur)} lufs={lufs} width="100%" />
          <div className="row sb">
            <span className="xs t3">{dims ? `${dims.w} × ${dims.h} · captions burned` : 'no render on this episode yet'}</span>
          </div>
        </div>

        <div className="wide" style={{ flex: '999 1 420px' }}>
          {isRunning(e.status) && <LiveStatus status={e.status} detail={e.status_detail} updatedAt={e.updated_at} />}
          {redrawing && <LiveStatus status={e.status} running detail={e.status_detail ?? `redraw of shot ${redrawing.shot_idx} ${redrawing.state}…`} updatedAt={e.updated_at} />}
          {!isRunning(e.status) && !redrawing && e.status_detail && <Note>{e.status_detail}</Note>}
          {!redrawing && lastRedraw?.state === 'failed' && e.status === 'awaiting_cut' && (
            <Note>
              Redraw of shot {lastRedraw.shot_idx} failed: {lastRedraw.reason}
            </Note>
          )}
          {!redrawing && lastRedraw?.state === 'done' && lastRedraw.render_id === e.final_render_id && (
            <Note>
              Shot {lastRedraw.shot_idx} redrawn{lastRedraw.note ? ` (“${lastRedraw.note}”)` : ''} — the player shows the new cut.{lastRedraw.reason ? ` ${lastRedraw.reason}.` : ''}
            </Note>
          )}
          {gen && e.final_render_id && gen.overlayOnly && (
            <Note>
              Overlay-only cut: {gen.generatedPlanned === 0 ? 'every shot was planned as an overlay' : `${gen.generatedPlanned} generated shot${gen.generatedPlanned === 1 ? '' : 's'} planned, none produced a clip, so each is drawn as its overlay`}.
              {gen.swaps.length > 0 && <span className="xs t3"> {gen.swaps.join(' · ')}</span>}
            </Note>
          )}
          {heroCards.length > 0 && (
            <section className="card" aria-label="Hero objects">
              <div className="card-h">
                <h2 className="h3">Hero objects</h2>
                <span className="xs t3">The sheet every picture was given · locked automatically</span>
              </div>
              <div className="card-b col" style={{ gap: 12 }}>
                {heroCards.map((h) => (
                  <ObjectSheetCard key={h.tag} episodeId={e.id} tag={h.tag} name={h.name} url={h.url} missing={h.missing} disabled={e.status === 'awaiting_cut' ? holdCut : 'only while the cut waits for your call'} />
                ))}
              </div>
            </section>
          )}
          <section className="card" aria-label="Shot list">
            <div className="card-h">
              <h2 className="h3">Shot list</h2>
              <span className="mono xs t3">
                {planFormat ? `${FORMAT_INFO[planFormat.format].label}${planFormat.format === 'engineered' && planMotion.success ? ` · ${MOTION_INFO[planMotion.data].label}` : ''}${planFormat.source === 'episode' ? ' (picked at approval)' : ''} · ` : ''}
                {shots.length} shots · {totalS.toFixed(2)} s{routes.length === 1 ? ` · all ${ROUTE_LABEL[routes[0]!] ?? routes[0]}` : ''}
              </span>
            </div>
            {shots.length === 0 && <div className="card-b sm t3">No shots on this episode yet.</div>}
            {shots.map((s) => {
              const qc = clips.filter((c) => c.shot_idx === s.idx).pop();
              return (
                <div className="shot" key={s.idx}>
                  <span className="mono sm t3">{s.idx}</span>
                  <span className="col" style={{ gap: 2, minWidth: 0 }}>
                    <span className="sm">{s.description}</span>
                    <span className="xs t3">
                      {ROUTE_LABEL[s.render_route ?? ''] ?? s.render_route ?? 'overlay'}
                      {qc && (
                        <span style={{ color: qc.passed ? 'var(--live)' : 'var(--blk-text)' }}> · QC {qc.passed ? 'pass' : `${qc.action}: ${qc.reasons.join(', ')}`}</span>
                      )}
                      {(castByShot.get(s.idx) ?? []).map((c) => (
                        <span key={c.part} style={{ display: 'block' }}>
                          picture {c.part + 1}: {c.drawn.length ? `drawn — ${c.drawn.join(', ')}` : 'nobody drawn'}
                          {c.excluded.length > 0 && ` · left out — ${c.excluded.map((x) => `${x.slug} (${x.reason})`).join('; ')}`}
                        </span>
                      ))}
                    </span>
                  </span>
                  <span className="mono sm">{s.dur.toFixed(1)} s</span>
                  {isVideoRoute(s.render_route) && e.status === 'awaiting_cut' ? <RegenerateButton episodeId={e.id} shotIdx={s.idx} /> : <span />}
                  {pictures.get(s.id) && (
                    <div className="col" style={{ gap: 10, gridColumn: '1 / -1', paddingTop: 6 }}>
                      {pictures.get(s.id)!.map((p, _i, all) => (
                        <RedrawPicture key={p.part} episodeId={e.id} shotIdx={s.idx} part={p.part} of={all.length} url={p.url} disabled={holdCut} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </div>

        <aside className="side" style={{ flex: '1 1 300px' }}>
          <section className="card" aria-label="QC">
            <div className="card-h">
              <h2 className="h3">QC</h2>
              <Gate state={measured.length === 0 ? 'unknown' : passed === measured.length ? 'pass' : 'fail'}>
                {measured.length === 0 ? '— not measured' : `${passed} / ${measured.length} pass`}
              </Gate>
            </div>
            <div className="card-b" style={{ paddingTop: 4, paddingBottom: 4 }}>
              {qcRows.map((r) => (
                <div className="qc" key={r.label}>
                  {r.state === 'pass' ? (
                    <Icon name="check" className="tlive" />
                  ) : r.state === 'fail' ? (
                    <Icon name="warn" className="trev" />
                  ) : (
                    <span className="ic t4" aria-hidden="true" style={{ display: 'grid', placeItems: 'center' }}>
                      —
                    </span>
                  )}
                  <span className="grow">{r.label}</span>
                  <span className={`mono${r.state === 'unknown' ? ' t3' : ''}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </section>
          {voice?.overflow === true && (
            <div className="note" style={{ padding: '12px 14px' }}>
              <Icon name="info" />
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontWeight: 600 }}>Voiced on the second model — main model’s daily limit</span>
                <span className="t2">
                  Every line of this episode is on the second voice model (Settings → Generation → Voice overflow), so it sounds the same throughout and slightly less
                  expressive than usual. {voice.respoken_lines ? `${voice.respoken_lines} line${voice.respoken_lines === 1 ? ' was' : 's were'} re-bought from the main model’s takes.` : ''}
                  {voice.overflow_reason ? ` Why: ${voice.overflow_reason}` : ''}
                </span>
              </div>
            </div>
          )}
          {unaligned !== null && unaligned > 0 && (
            <div className="note" style={{ padding: '12px 14px' }}>
              <Icon name="info" />
              <div className="col" style={{ gap: 2 }}>
                <span style={{ fontWeight: 600 }}>Listen to every line · {unaligned}</span>
                <span className="t2">
                  {unaligned} of {voice?.lines ?? '—'} lines could not be checked against the script automatically, and caption as whole lines. Play the cut with sound before approving.
                </span>
              </div>
            </div>
          )}
          {e.status === 'awaiting_cut' ? (
            <section className="card" aria-label="Your call">
              <div className="card-h">
                <h2 className="h3">Your call</h2>
              </div>
              <div className="card-b">
                <CutControls episodeId={e.id} slot={e.slot_id ?? 'this episode'} unaligned={unaligned} blocked={holdCut} />
              </div>
            </section>
          ) : (
            <div className="empty">
              <span style={{ color: 'var(--t2)', fontWeight: 500 }}>Not ready for your call</span>
              <span>{e.status === 'cut_rejected' ? 'Sent back. Set what changes below; the new cut returns here.' : 'This cut is still being made.'}</span>
            </div>
          )}
          {e.status === 'cut_rejected' && recut && <RecutForm episodeId={e.id} options={recut} />}
        </aside>
      </div>
    </main>
  );
}
