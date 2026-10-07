import Link from 'next/link';

import { inr } from '@/components/ui/card';
import { Cones, runCones } from '@/components/ui/episode';
import { EpisodeStatePill } from '@/components/ui/tags';
import { serverClient } from '@/lib/db/server';
import { isDeferrable } from '@/lib/onboarding/gate';
import type { Spine } from '@/lib/onboarding/spine';
import { allIntegrationViews } from '@/lib/onboarding/step-view';
import { channelEpisodes, titleOf } from '@/lib/screens/common';
import { railData } from '@/lib/shell/rail';

import { DeferForm } from '@/app/(setup)/setup/[step]/defer-form';

import { EnvRows, stateOf } from '../integration-section';
import { StepFoot, StepHead } from './studio';

/**
 * Connections (canvas: Onb-Connections) and the first-episode walkthrough (canvas:
 * Onb-Finish). Connections are optional: nothing before publishing needs them, and
 * Instagram stays manual until Meta app review clears. Testing a connection happens on the
 * Integrations screen, which owns those checks; this page shows what is found and what is not.
 */

const OPTIONAL: { slug: string; title: string; why: string; manual?: string }[] = [
  { slug: 'youtube', title: 'YouTube', why: 'Reads analytics back for Metrics. Uploading stays manual in Phase 1.' },
  { slug: 'instagram', title: 'Instagram', why: 'Reads reach back for Metrics.', manual: 'Manual until Meta app review clears — you post the bundle yourself.' },
  { slug: 'slack', title: 'Alerts', why: 'Where a refusal, a finished cut or a crossed cap is announced.' },
];

export async function ConnectionsPage({ spine }: { spine: Spine }) {
  const views = await allIntegrationViews().catch(() => null);
  const deferred = spine.progress.deferred.find((d) => d.step === 9) ?? null;
  return (
    <>
      <StepHead slug="connections" title="Connections" lead="Optional. Nothing before publishing needs these — skip now and add them from Settings whenever you like." />
      {deferred && (
        <div className="em">
          <span>Skipped. Fine — each one lives in Settings → Integrations.</span>
        </div>
      )}
      {views === null ? (
        <div className="blocker" role="alert">
          <span aria-hidden="true" className="tblk">
            !
          </span>
          <p>
            Integrations could not be read. <span>Run pnpm db:doctor to see which failure this is.</span>
          </p>
        </div>
      ) : (
        OPTIONAL.map((o) => {
          const v = views.find((x) => x.slug === o.slug) ?? null;
          const st = v ? stateOf(v) : null;
          return (
            <section key={o.slug} className="card card-b col" style={{ gap: 12 }}>
              <div className="row sb">
                <div className="col" style={{ gap: 2 }}>
                  <h2 className="h3">{o.title}</h2>
                  <span className="xs t3">{o.why}</span>
                </div>
                {o.manual ? <span className="pill s-rev">manual</span> : st ? <span className={`pill s-${st.tone}`}>{st.text}</span> : <span className="pill">—</span>}
              </div>
              {o.manual && <p className="sm t2">{o.manual}</p>}
              {v ? <EnvRows view={v} optional /> : <div className="em"><span>Not in this build’s integration catalogue.</span></div>}
            </section>
          );
        })
      )}
      <section className="card card-b col" style={{ gap: 10 }}>
        <span className="h3">Kiln’s own MCP server</span>
        <span className="sm t2">Lets an agent draft and queue briefs for a channel. Tokens are issued on the MCP settings screen; agents never approve.</span>
        <Link className="btn sm" href="/settings/mcp" style={{ alignSelf: 'flex-start' }}>
          MCP settings
        </Link>
      </section>
      <div className="row" style={{ gap: 10 }}>
        <Link className="btn" href="/settings/integrations">
          Test on Integrations
        </Link>
      </div>
      {isDeferrable(9) && <DeferForm stepNumber={9} deferred={deferred ? { reason: deferred.reason, at: deferred.at } : null} />}
      <StepFoot slug="connections" />
    </>
  );
}

const WALK = [
  { k: 'approvals', title: 'Approve a brief', body: 'Read the premise, the cast and the estimate. Approving starts the paid run; rejecting spends nothing.', href: '/bureau/approvals', cta: 'Approvals' },
  { k: 'cuts', title: 'Watch the cut', body: 'Kiln voices, generates and assembles it. Watch every second — the review is the gate, and it cannot be skipped.', href: '/bureau/cuts', cta: 'Cuts' },
  { k: 'ready', title: 'Approve and download', body: 'An approved cut becomes a bundle: the video, the title, the caption and the disclosure. You post it yourself.', href: '/bureau/ready', cta: 'Ready' },
] as const;

export async function FinishPage({ spine }: { spine: Spine }) {
  const locked = spine.blockers.length > 0;
  const [rail, episodes] = await Promise.all([
    railData(),
    spine.channel ? channelEpisodes(serverClient(), spine.channel.id, 50).catch(() => null) : Promise.resolve(null),
  ]);
  const latest = episodes && episodes.length ? [...episodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]! : null;
  const count = (k: (typeof WALK)[number]['k']) => rail.counts[k];

  return (
    <>
      <StepHead slug="finish" title="Your first episode" lead="Three screens, in this order. Each one names what it waits on." />
      {locked ? (
        <section className="card card-b col" style={{ gap: 10 }}>
          <span className="h3">Not yet</span>
          <span className="sm t2">These still block the first video:</span>
          {spine.blockers.map((b) => (
            <Link key={b.slug} href={`/setup/${b.slug}`} className="blocker">
              <span aria-hidden="true" className="tblk">
                !
              </span>
              <p>{b.text}</p>
            </Link>
          ))}
        </section>
      ) : (
        <>
          {latest ? (
            <section className="card card-b col" style={{ gap: 12 }}>
              <div className="row sb">
                <span className="h3">{titleOf(latest.premise)}</span>
                <EpisodeStatePill status={latest.status} />
              </div>
              <Cones states={runCones(latest.status, { stoppedAt: latest.statusDetail })} right={<span className="xs t3 mono">{latest.estimateInr === null ? '— no estimate' : `${inr(latest.estimateInr)} estimate`}</span>} />
            </section>
          ) : (
            <div className="em">
              <span>{spine.channel ? `${spine.channel.name} has no episode yet. Briefs are drafted for the next slot; the first lands on Approvals.` : 'No channel yet.'}</span>
            </div>
          )}
          <ol className="col" style={{ gap: 10, listStyle: 'none', padding: 0, margin: 0 }}>
            {WALK.map((w, i) => {
              const n = count(w.k);
              return (
                <li key={w.k} className="card card-b row" style={{ gap: 14, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <span className="mono h3 t3" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="col grow" style={{ gap: 4 }}>
                    <span className="h3">{w.title}</span>
                    <span className="sm t2">{w.body}</span>
                    <span className="xs t3">{n === null ? '— count not readable' : n === 0 ? 'nothing waiting here now' : `${n} waiting`}</span>
                  </div>
                  <Link className="btn sm" href={w.href}>
                    {w.cta}
                  </Link>
                </li>
              );
            })}
          </ol>
        </>
      )}
      <StepFoot slug="finish" nextLabel="Go to Home" nextHref="/home" />
    </>
  );
}
