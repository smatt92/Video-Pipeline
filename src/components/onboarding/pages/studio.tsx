import Link from 'next/link';
import type { ReactNode } from 'react';

import { RateRow } from '@/components/settings/rate-row';
import { readRateCard } from '@/lib/cost/rate-card';
import { serverClient } from '@/lib/db/server';
import { pageNeighbours, setupPage } from '@/lib/onboarding/pages';
import type { Spine } from '@/lib/onboarding/spine';
import { stepIntegrationView } from '@/lib/onboarding/step-view';
import { STEPS, isUnlocked } from '@/lib/onboarding/steps';

import { IntegrationSection } from '../integration-section';
import { ProfileForm, RateCardForm } from '../step-forms';

/**
 * Studio pages (canvas: Onb-Studio, Onb-Models, Onb-Generation (the canvas names the vendor here — no
 * vendor is named outside the driver layer), Onb-Rates). Each composes the existing step
 * forms; Save and test is the step's own check, and passing it is what ticks the step.
 */

const step = (n: number) => STEPS.find((s) => s.n === n)!;

export function StepHead({ slug, title, lead, extra }: { slug: string; title: string; lead: ReactNode; extra?: string }) {
  const p = setupPage(slug)!;
  return (
    <div className="col" style={{ gap: 8 }}>
      <span className="ob-step">
        {p.group} · step {p.n} of 10{extra ? ` · ${extra}` : ''}
      </span>
      <h1 className="ob-h">{title}</h1>
      <p className="t2">{lead}</p>
    </div>
  );
}

export function StepFoot({ slug, children, nextLabel, nextHref }: { slug: string; children?: ReactNode; nextLabel?: string; nextHref?: string }) {
  const p = setupPage(slug)!;
  const { prev, next } = pageNeighbours(p);
  return (
    <div className="ob-foot">
      <Link className="btn ghost" href={prev ? `/setup/${prev.slug}` : '/setup'}>
        Back
      </Link>
      {children}
      <span className="grow" />
      {(next || nextHref) && (
        <Link className="btn pri" href={nextHref ?? `/setup/${next!.slug}`} style={{ flex: '0 1 auto' }}>
          {nextLabel ?? `Next · ${next!.label}`}
        </Link>
      )}
    </div>
  );
}

function lockedBy(n: number, completed: readonly number[]): string | null {
  const s = step(n);
  if (isUnlocked(s, completed)) return null;
  return s.blockedBy
    .filter((b) => !completed.includes(b))
    .map((b) => step(b).title)
    .join(' and ');
}

export async function StudioPage({ spine }: { spine: Spine }) {
  const [storage, profile] = await Promise.all([
    stepIntegrationView(2),
    spine.progress.userId
      ? serverClient().from('profiles').select('display_name, timezone, currency, usd_inr_rate').eq('id', spine.progress.userId).maybeSingle().then((r) => r.data)
      : Promise.resolve(null),
  ]);
  const profileDone = spine.progress.completed.includes(1);
  return (
    <>
      <StepHead slug="studio" title="You and where the files go" lead="Kiln uses your timezone for every slot and your exchange rate for every ₹ estimate." />
      <section className="card card-b col" style={{ gap: 16 }}>
        <div className="row sb">
          <h2 className="h3">Profile</h2>
          <span className={`pill ${profileDone ? 's-live' : 's-rev'}`}>{profileDone ? 'saved' : 'not saved'}</span>
        </div>
        {!profile?.usd_inr_rate && (
          <div className="em">
            <span>No exchange rate yet. Every ₹ shows “—” until you add one.</span>
          </div>
        )}
        <ProfileForm
          email={spine.progress.email}
          defaults={profile ? { displayName: profile.display_name, timezone: profile.timezone, currency: profile.currency, usdInrRate: profile.usd_inr_rate === null ? null : Number(profile.usd_inr_rate) } : undefined}
        />
      </section>
      <IntegrationSection title="Storage" sub="The bucket everything generated is written to" view={storage} stepNumber={2} verification={step(2).verification} locked={lockedBy(2, spine.progress.completed)} />
      <StepFoot slug="studio" />
    </>
  );
}

export async function ModelsPage({ spine }: { spine: Spine }) {
  const [writing, embeddings] = await Promise.all([stepIntegrationView(3), stepIntegrationView(11)]);
  return (
    <>
      <StepHead slug="models" title="Writing and repetition checks" lead="The writing model drafts briefs and scripts. Embeddings stop the channel from repeating itself." />
      <IntegrationSection title="Writing model" sub="Briefs, beat sheets, scripts, titles" view={writing} stepNumber={3} verification={step(3).verification} locked={lockedBy(3, spine.progress.completed)} />
      <IntegrationSection title="Embeddings" sub="Compares each new brief with recent ones" view={embeddings} stepNumber={11} verification={step(11).verification} locked={lockedBy(11, spine.progress.completed)} />
      {embeddings && embeddings.state !== 'verified' && <p className="xs t3">Until embeddings verify, every brief is refused by name — a repetition check that did not run has not passed.</p>}
      <StepFoot slug="models" />
    </>
  );
}

export async function GenerationPage({ spine }: { spine: Spine }) {
  const [video, voice] = await Promise.all([stepIntegrationView(4), stepIntegrationView(5)]);
  return (
    <>
      <StepHead
        slug="generation"
        title="Video and voices"
        lead="One key covers both (decision 0015). Kiln checks the key and reads the credit balance; it never generates a clip just to test."
      />
      <IntegrationSection title="Generation · video" sub={step(4).blurb} view={video} stepNumber={4} verification={step(4).verification} locked={lockedBy(4, spine.progress.completed)} />
      <IntegrationSection
        title="Voiceover · voices"
        sub="Spoken on the same key; word timings come from forced alignment on the worker."
        view={voice}
        stepNumber={5}
        verification={step(5).verification}
        fieldsHidden
        locked={lockedBy(5, spine.progress.completed)}
      />
      <StepFoot slug="generation" />
    </>
  );
}

export async function RatesPage({ spine }: { spine: Spine }) {
  const rates = await readRateCard(serverClient());
  const fx = spine.progress.userId
    ? (await serverClient().from('profiles').select('usd_inr_rate').eq('id', spine.progress.userId).maybeSingle()).data?.usd_inr_rate ?? null
    : null;
  const unverified = rates.ok ? rates.rows.filter((r) => !r.isVerified).length : null;
  const locked = lockedBy(6, spine.progress.completed);
  return (
    <>
      <StepHead
        slug="rate-card"
        title="Rate card"
        lead={`Every ₹ estimate is price × quantity × your rate${fx ? ` of ₹${Number(fx)} per dollar` : ''}. A price counts as verified only after you check it against the provider’s own pricing.`}
      />
      {!rates.ok ? (
        <div className="blocker" role="alert">
          <span aria-hidden="true" className="tblk">
            !
          </span>
          <p>
            The rate card could not be read. <span>{rates.hint}</span>
          </p>
        </div>
      ) : rates.rows.length === 0 ? (
        <div className="em">
          <span>No prices yet. The migrations seed one row per driver, model and unit, so an empty card means they did not land.</span>
        </div>
      ) : (
        <section className="card" aria-label="Rates" style={{ overflowX: 'auto' }}>
          {rates.rows.map((r) => (
            <RateRow key={r.id} row={r} />
          ))}
        </section>
      )}
      {unverified !== null && unverified > 0 && (
        <div className="blocker">
          <span aria-hidden="true" className="tblk">
            !
          </span>
          <p>
            {unverified} rate{unverified === 1 ? '' : 's'} {unverified === 1 ? 'has' : 'have'} no verified price. <span>Any stage that would spend on {unverified === 1 ? 'it' : 'them'} refuses, and its ₹ shows “—”.</span>
          </p>
        </div>
      )}
      <section className="card card-b col" style={{ gap: 10 }}>
        <span className="h3">Confirm</span>
        <span className="sm t2">{step(6).verification}</span>
        {locked ? (
          <div className="em">
            <span>Locked until {locked} passes.</span>
          </div>
        ) : (
          <RateCardForm />
        )}
      </section>
      <StepFoot slug="rate-card" nextLabel="Next · Your first channel" />
    </>
  );
}
