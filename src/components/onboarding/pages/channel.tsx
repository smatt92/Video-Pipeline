import Link from 'next/link';

import { TakePlayer } from '@/components/library/take-player';
import { Bust } from '@/components/ui/bust';
import { LockTag } from '@/components/ui/tags';
import { bibleOrNull } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { TTS_PRESET_IDS } from '@/lib/drivers/voice-route';
import { voicesScreen, type VoiceRow } from '@/lib/library/voices';
import { activeChannel } from '@/lib/onboarding/channel-step';
import type { Spine } from '@/lib/onboarding/spine';
import { channelPolicy, longDate, todayIn, upcomingSlots } from '@/lib/screens/common';
import { storage } from '@/lib/storage';

import { CapsForm, LockVoiceForm, NewChannelForm, TrendsForm } from '../channel-forms';
import { ExistingChannelForm } from '../step-forms';
import { StepFoot, StepHead } from './studio';

/**
 * Channel pages (canvas: Onb-ChBasics, Onb-ChCast, Onb-ChSchedule, Onb-ChCaps). They run
 * again for every channel from + Add channel (`/setup/basics?new=1`), and each reads the
 * active channel's own rows — a page is done when the channel is, never because a box was
 * ticked.
 */

function NoChannel({ what }: { what: string }) {
  return (
    <div className="em">
      <span>No channel yet, so there is no {what} to set.</span>
      <Link className="btn sm pri" href="/setup/basics?new=1">
        Create a channel
      </Link>
    </div>
  );
}

function Refusal({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="blocker" role="alert">
      <span aria-hidden="true" className="tblk">
        !
      </span>
      <p>
        {text} {hint && <span>{hint}</span>}
      </p>
    </div>
  );
}

async function usedAccents(): Promise<string[]> {
  const { data } = await serverClient().from('channel_characters').select('accent_hex');
  return [...new Set((data ?? []).map((r) => String(r.accent_hex).toLowerCase()))];
}

export async function BasicsPage({ spine, fresh }: { spine: Spine; fresh: boolean }) {
  const db = serverClient();
  const channel = fresh || !spine.channel ? null : await activeChannel(db, spine.channel.id);
  const accents = channel ? [] : await usedAccents();
  return (
    <>
      <StepHead
        slug="basics"
        title={channel ? channel.name : fresh && spine.channel ? 'Add another channel' : 'Your first channel'}
        lead={
          channel
            ? 'This channel exists. Its name, niche and handle are below; add another to run a second cast and calendar.'
            : 'A channel starts from the template bible — one host, the default series, policy and trend sources — and you change all of it on the next three pages.'
        }
        extra="repeatable"
      />
      <section className="card card-b col" style={{ gap: 16 }}>
        {channel ? (
          <>
            <ExistingChannelForm channel={channel} />
            <Link className="btn" href="/setup/basics?new=1" style={{ alignSelf: 'flex-start' }}>
              + Add another channel
            </Link>
          </>
        ) : (
          <NewChannelForm usedAccents={accents} />
        )}
      </section>
      <p className="xs t3">Instagram publishing is manual until Meta app review clears: Kiln prepares the bundle, you post it.</p>
      <StepFoot slug="basics" />
    </>
  );
}

async function takeUrl(row: VoiceRow): Promise<string | null> {
  if (!row.take) return null;
  return storage()
    .presignGet({ key: row.take.storageKey, expiresIn: 3600 })
    .then((p) => p.url)
    .catch(() => null);
}

export async function CastPage({ spine, pick }: { spine: Spine; pick: string | null }) {
  if (!spine.channel) {
    return (
      <>
        <StepHead slug="cast" title="Cast and voices" lead="Every character needs one locked voice before a line can be recorded." />
        <NoChannel what="cast" />
        <StepFoot slug="cast" />
      </>
    );
  }
  const bible = bibleOrNull(spine.channel);
  if (!bible) {
    return (
      <>
        <StepHead slug="cast" title="Cast and voices" lead="Every character needs one locked voice before a line can be recorded." />
        <Refusal text={`${spine.channel.name} has no bible, so it has no cast.`} hint="Channels made here get one from the template; this one predates it." />
        <StepFoot slug="cast" />
      </>
    );
  }
  let screen: Awaited<ReturnType<typeof voicesScreen>> | null = null;
  let error: string | null = null;
  try {
    screen = await voicesScreen(serverClient(), spine.channel.id, bible);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const rows = screen?.rows ?? [];
  const sel = rows.find((r) => r.slug === pick) ?? rows.find((r) => !r.route.ok) ?? rows[0] ?? null;
  const url = sel ? await takeUrl(sel) : null;
  const unlocked = rows.filter((r) => !r.route.ok).length;

  return (
    <>
      <StepHead
        slug="cast"
        title="Cast and voices"
        lead="Lock one preset per character. Auditions play takes already recorded — nothing is generated from this page, so it cannot spend."
        extra={spine.channel.name}
      />
      {error && <Refusal text="The cast could not be read." hint={error} />}
      {screen?.tableMissing && <Refusal text="Voice overrides cannot be read." hint={`${screen.tableMissing} The bible’s locks still apply.`} />}
      {rows.length === 0 && !error ? (
        <div className="em">
          <span>The bible has no characters. Add one in the channel’s settings, then lock its voice here.</span>
        </div>
      ) : (
        <div className="kgrid ga-300" style={{ alignItems: 'start' }}>
          <section className="card" aria-label="Cast">
            {rows.map((r) => (
              <Link
                key={r.slug}
                href={`/setup/cast?c=${r.slug}`}
                className="crow"
                aria-current={sel?.slug === r.slug ? 'true' : undefined}
                style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 14px', minHeight: 56, borderBottom: '1px solid var(--b1)', background: sel?.slug === r.slug ? 'var(--s2)' : undefined }}
              >
                <Bust slug={r.slug} accent={r.accentHex} size="sm" />
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="sm" style={{ fontWeight: 500 }}>
                    {r.name}
                  </span>
                  <span className="xs t3">{r.role}</span>
                </span>
                {r.route.ok ? <LockTag>{r.route.voiceId}</LockTag> : <span className="pill s-blk">no voice</span>}
              </Link>
            ))}
          </section>
          {sel && (
            <section className="card card-b col" style={{ gap: 14 }}>
              <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
                <Bust slug={sel.slug} accent={sel.accentHex} size="md" />
                <div className="col" style={{ gap: 4, minWidth: 0 }}>
                  <h2 className="h2">{sel.name}</h2>
                  <span className="xs t3">{sel.voiceBrief}</span>
                </div>
              </div>
              {!sel.route.ok && <Refusal text={sel.route.detail} />}
              {sel.overrideProblem && <Refusal text="The stored override is unusable." hint={sel.overrideProblem} />}
              {url && sel.take ? (
                <TakePlayer src={url} name={sel.name} accent={sel.accentHex} label={`Last take${sel.take.matchesRoute ? '' : ' · a different voice'}`} />
              ) : (
                <div className="em">
                  <span>{sel.take ? 'The last take could not be fetched from storage.' : 'No take yet — the first episode records one in the locked voice.'}</span>
                </div>
              )}
              <LockVoiceForm channelId={spine.channel.id} slug={sel.slug} name={sel.name} presets={TTS_PRESET_IDS} current={sel.bible.presetId} />
            </section>
          )}
        </div>
      )}
      <StepFoot slug="cast">{unlocked > 0 && <span className="xs t3">{unlocked} still to lock</span>}</StepFoot>
    </>
  );
}

export async function SchedulePage({ spine }: { spine: Spine }) {
  if (!spine.channel) {
    return (
      <>
        <StepHead slug="schedule" title="Series and slots" lead="Which series run, on which days, and the next publish slots." />
        <NoChannel what="schedule" />
        <StepFoot slug="schedule" />
      </>
    );
  }
  const db = serverClient();
  const bible = bibleOrNull(spine.channel);
  const policy = await channelPolicy(db, spine.channel.id).catch(() => null);
  const tz = policy?.tz ?? 'Asia/Kolkata';
  let slots: Awaited<ReturnType<typeof upcomingSlots>> | null = null;
  try {
    slots = await upcomingSlots(db, spine.channel.id, todayIn(tz), 7);
  } catch {
    slots = null;
  }
  const series = bible ? Object.values(bible.series) : [];
  return (
    <>
      <StepHead slug="schedule" title="Series and slots" lead="The series come from the channel’s bible; slots are the dates Kiln fills, one episode each." extra={spine.channel.name} />
      <section className="card" aria-label="Series">
        <div className="card-h">
          <span className="h3">Series</span>
          <span className="xs t3">{series.length || '—'}</span>
        </div>
        {series.length === 0 ? (
          <div className="em" style={{ margin: 14 }}>
            <span>{bible ? 'The bible runs no series, so no slot can be filled.' : 'No bible, so no series.'}</span>
          </div>
        ) : (
          series.map((s) => (
            <div key={s!.id} style={{ display: 'flex', gap: 12, padding: '10px 14px', borderTop: '1px solid var(--b1)', flexWrap: 'wrap' }}>
              <span className="sm grow" style={{ fontWeight: 500 }}>
                {s!.name}
              </span>
              <span className="xs t3">{s!.day}</span>
              <span className="xs t3 mono">
                {s!.runtime_s.target}s · led by {s!.lead.join(', ')}
              </span>
            </div>
          ))
        )}
      </section>
      <section className="card" aria-label="First week">
        <div className="card-h">
          <span className="h3">Next slots</span>
          <span className="xs t3">
            {policy ? `${policy.slotTime} · ${tz}` : 'publish time not set'}
          </span>
        </div>
        {slots === null ? (
          <div style={{ margin: 14 }}>
            <Refusal text="Slots could not be read." />
          </div>
        ) : slots.length === 0 ? (
          <div className="em" style={{ margin: 14 }}>
            <span>No slot from today on, so there is nothing to fill. Slots come from the topic calendar, loaded as SQL (scripts/calendar-sql.mjs) — this build has no screen that adds one.</span>
          </div>
        ) : (
          slots.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: 12, padding: '10px 14px', borderTop: '1px solid var(--b1)', flexWrap: 'wrap' }}>
              <span className="sm mono" style={{ minWidth: 120 }}>
                {longDate(s.date)}
              </span>
              <span className="sm grow">{s.seriesName ?? s.series ?? '—'}</span>
              <span className="xs t3">{s.topic ?? s.seasonalTag ?? 'open'}</span>
            </div>
          ))
        )}
      </section>
      <p className="xs t3">Series are edited in the channel bible; this page reads them, it does not change them.</p>
      <StepFoot slug="schedule" />
    </>
  );
}

export async function CapsPage({ spine }: { spine: Spine }) {
  if (!spine.channel) {
    return (
      <>
        <StepHead slug="caps" title="Caps and trends" lead="What a day, a month and one Short may spend, and where ideas come from." />
        <NoChannel what="cap" />
        <StepFoot slug="caps" />
      </>
    );
  }
  const policy = await channelPolicy(serverClient(), spine.channel.id).catch(() => null);
  const bible = bibleOrNull(spine.channel);
  return (
    <>
      <StepHead slug="caps" title="Caps and trends" lead="Kiln refuses a paid run that would cross a cap. A cap left empty is not unlimited — nothing paid starts until it is set." extra={spine.channel.name} />
      <section className="card card-b col" style={{ gap: 14 }}>
        <span className="h3">Spend caps · ₹</span>
        {policy ? (
          <CapsForm channelId={spine.channel.id} caps={{ daily: policy.dailyCap, monthly: policy.monthlyCap, perShort: policy.perShortCap, longform: policy.longformDayCap }} />
        ) : (
          <Refusal text="The channel’s policy row could not be read." hint="Every channel gets one when it is created; a missing row means the 0022 migration did not land." />
        )}
      </section>
      <section className="card card-b col" style={{ gap: 14 }}>
        <span className="h3">Trend sources</span>
        {bible ? (
          <TrendsForm channelId={spine.channel.id} subreddits={[...bible.trends.subreddits]} youtube={bible.trends.youtube ? { region_code: bible.trends.youtube.region_code, category_ids: [...bible.trends.youtube.category_ids], queries: [...bible.trends.youtube.queries] } : null} />
        ) : (
          <div className="em">
            <span>No bible, so no trend sources.</span>
          </div>
        )}
      </section>
      <StepFoot slug="caps" />
    </>
  );
}
