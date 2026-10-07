import Link from 'next/link';

import { CutControls, RegenerateButton } from '@/components/bureau/cut-controls';
import { LiveRefresh, LiveStatus } from '@/components/bureau/live-status';
import { ScreenHeader } from '@/components/shell/screen-header';
import { inr, Note } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Player } from '@/components/ui/player';
import { Basis, EpisodeStatePill, Gate } from '@/components/ui/tags';
import { isVideoRoute } from '@/lib/bureau/estimate';
import { channelGeneration, episodeClips } from '@/lib/bureau/overlay-only';
import { isRunning } from '@/lib/bureau/running';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { titleOf } from '@/lib/screens/common';
import { storage } from '@/lib/storage';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Cuts' };

type Clip = { shot_idx: number; passed: boolean; reasons: string[]; action: string };

const ROUTE_LABEL: Record<string, string> = { overlay: 'overlay', still: 'scene still', character_beat: 'character beat', money_shot: 'money shot' };

/**
 * Cuts (canvas: Cuts, Cuts-m) — the second gate. The composite in the 9:16 player with a scrub
 * segmented by shot, the shot list with the route of each and Regenerate where a re-roll exists
 * (video routes only; a still or an overlay has nothing to re-roll), QC against what was
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
  const briefs = briefIds.length ? (await db.from('briefs').select('id, premise, policy').in('id', briefIds)).data ?? [] : [];
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
  let url: string | null = null;
  let dims: { w: number; h: number; dur: number | null } | null = null;
  if (e.final_render_id) {
    const { data: r } = await db.from('renders').select('asset_id, width, height, duration_s').eq('id', e.final_render_id).maybeSingle();
    if (r) dims = { w: r.width, h: r.height, dur: r.duration_s === null ? null : Number(r.duration_s) };
    const { data: a } = r?.asset_id ? await db.from('assets').select('storage_key').eq('id', r.asset_id).maybeSingle() : { data: null };
    url = a ? await storage().presignGet({ key: a.storage_key, expiresIn: 3600 }).then((p) => p.url).catch(() => null) : null;
  }
  const { data: shotRows } = e.script_id
    ? await db.from('shots').select('idx, render_route, duration_s, effective_duration_s, status, description').eq('script_id', e.script_id).order('idx')
    : { data: [] };
  const shots = (shotRows ?? []).map((s) => ({ ...s, dur: Number(s.effective_duration_s ?? s.duration_s) }));
  // v_episode_spend coalesces to 0, so an episode with no script (no ledger row can attach)
  // would read as free. Absent is not zero: without a script the figure is withheld.
  const { data: spendRow } = e.script_id ? await db.from('v_episode_spend').select('spent_inr, unpriced_rows').eq('episode_id', e.id).maybeSingle() : { data: null };
  const spend = spendRow;
  const qcObj = (e.qc ?? {}) as { clips?: Record<string, Clip>; loudness_lufs?: number | null };
  const clips = Object.values(qcObj.clips ?? {});
  const lufs = qcObj.loudness_lufs ?? null;
  const gen = await episodeClips(db, e);
  const voice = e.voice_detail as { unaligned?: number | null; lines?: number } | null;
  const unaligned = voice?.unaligned ?? null;
  const totalS = shots.reduce((n, s) => n + s.dur, 0);
  const policyStatus = (brief?.policy as { status?: string } | null)?.status ?? null;
  const routes = [...new Set(shots.map((s) => s.render_route ?? 'overlay'))];

  type QcRow = { label: string; state: 'pass' | 'fail' | 'unknown'; value: string };
  const qcRows: QcRow[] = [
    { label: 'Loudness', state: lufs === null ? 'unknown' : Math.abs(lufs + 14) <= 1.5 ? 'pass' : 'fail', value: lufs === null ? '— not measured' : `${lufs.toFixed(1)} LUFS` },
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
      <LiveRefresh active={list.some((x) => isRunning(x.status))} />
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

      {readiness.summary && <Note>{readiness.summary} A viewer sees the chalk diagrams and none of the cast; nothing is spent on this.</Note>}

      <div className="split">
        <div className="cutcol">
          <Player src={url} label={e.slot_id ?? 'cut'} shots={shots.map((s) => s.dur)} lufs={lufs} width="100%" />
          <div className="row sb">
            <span className="xs t3">{dims ? `${dims.w} × ${dims.h} · captions burned` : 'no render on this episode yet'}</span>
          </div>
        </div>

        <div className="wide" style={{ flex: '999 1 420px' }}>
          {isRunning(e.status) && <LiveStatus status={e.status} detail={e.status_detail} updatedAt={e.updated_at} />}
          {!isRunning(e.status) && e.status_detail && <Note>{e.status_detail}</Note>}
          {gen && e.final_render_id && gen.overlayOnly && (
            <Note>
              Overlay-only cut: {gen.generatedPlanned === 0 ? 'every shot was planned as an overlay' : `${gen.generatedPlanned} generated shot${gen.generatedPlanned === 1 ? '' : 's'} planned, none produced a clip, so each is drawn as its overlay`}.
              {gen.swaps.length > 0 && <span className="xs t3"> {gen.swaps.join(' · ')}</span>}
            </Note>
          )}
          <section className="card" aria-label="Shot list">
            <div className="card-h">
              <h2 className="h3">Shot list</h2>
              <span className="mono xs t3">
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
                    </span>
                  </span>
                  <span className="mono sm">{s.dur.toFixed(1)} s</span>
                  {isVideoRoute(s.render_route) && e.status === 'awaiting_cut' ? <RegenerateButton episodeId={e.id} shotIdx={s.idx} /> : <span />}
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
                <CutControls episodeId={e.id} slot={e.slot_id ?? 'this episode'} unaligned={unaligned} />
              </div>
            </section>
          ) : (
            <div className="empty">
              <span style={{ color: 'var(--t2)', fontWeight: 500 }}>Not ready for your call</span>
              <span>{e.status === 'cut_rejected' ? 'Sent back — it returns here when the fix is cut.' : 'This cut is still being made.'}</span>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
