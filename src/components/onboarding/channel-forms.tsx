'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type CSSProperties } from 'react';

import { createChannelAction, lockVoiceAction, updatePolicyAction, updateTrendSourcesAction } from '@/lib/channels/actions';
import { CHANNEL_ACCENTS } from '@/styles/brand';

/**
 * The per-channel setup forms (canvas: Onb-ChBasics, Onb-ChCast, Onb-ChCaps). Presentation
 * over the 0022 actions — createChannelAction, lockVoiceAction, updatePolicyAction,
 * updateTrendSourcesAction — which validate, write, read back and log; a refusal comes back
 * as one sentence and is shown as the blocker, never retried here.
 */

type Result = { ok: true; message: string } | { ok: false; refused: string } | null;

function Outcome({ r }: { r: Result }) {
  if (!r) return null;
  return r.ok ? (
    <div className="row sm" role="status" style={{ gap: 8, color: 'var(--live)', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <span aria-hidden="true">✓</span>
      <span>{r.message}</span>
    </div>
  ) : (
    <div className="blocker" role="alert">
      <span aria-hidden="true" className="tblk">
        !
      </span>
      <p>{r.refused}</p>
    </div>
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export function NewChannelForm({ usedAccents }: { usedAccents: string[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [handle, setHandle] = useState('');
  const [yt, setYt] = useState(true);
  const [ig, setIg] = useState(false);
  const [ytId, setYtId] = useState('');
  const [accent, setAccent] = useState<string>(CHANNEL_ACCENTS.find((a) => !usedAccents.includes(a.hex.toLowerCase()))?.hex ?? CHANNEL_ACCENTS[0].hex);
  const [r, setR] = useState<Result>(null);
  const [pending, start] = useTransition();
  const clash = usedAccents.includes(accent.toLowerCase());
  const initials = name
    .split(/\s+/)
    .filter((w) => w && !/^(of|the|and|a)$/i.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

  const submit = () =>
    start(async () => {
      const res = await createChannelAction({
        name,
        slug: slug || slugify(name),
        handle: handle || undefined,
        accent_hex: accent,
        youtube_channel_id: ytId || undefined,
        targets: [...(yt ? (['youtube'] as const) : []), ...(ig ? (['instagram'] as const) : [])],
      });
      setR(res.ok ? { ok: true, message: `${res.message}${res.warnings.length ? ` ${res.warnings.join('; ')}.` : ''}` } : res);
      if (res.ok) router.push('/setup/cast');
    });

  return (
    <div className="col" style={{ gap: 16 }}>
      <section className="card card-b col" style={{ gap: 14 }}>
        <div className="kgrid ga-220">
          <div className="field">
            <label htmlFor="cn">Channel name</label>
            <input
              id="cn"
              className="input"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
              placeholder="Kitchen Physics"
            />
          </div>
          <div className="field">
            <label htmlFor="ch">Handle</label>
            <input id="ch" className="input mono" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@handle" />
          </div>
          <div className="field">
            <label htmlFor="cs">Short name (slug)</label>
            <input
              id="cs"
              className="input mono"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              placeholder="kitchen-physics"
            />
            <span className="xs t3">Lowercase letters, digits and hyphens. Names the channel’s bible; it cannot change later.</span>
          </div>
        </div>
      </section>

      <section className="card card-b col" style={{ gap: 12 }}>
        <span className="h3">Where it publishes</span>
        <label className="plat-opt">
          <input type="checkbox" checked={yt} onChange={(e) => setYt(e.target.checked)} />
          <span className="col" style={{ gap: 2 }}>
            <span style={{ fontWeight: 500 }}>YouTube Shorts</span>
            <span className="xs t3">You still upload and schedule; Kiln prepares the bundle and records the link.</span>
          </span>
          <span className="pill s-rev nodot">manual upload</span>
        </label>
        {yt && (
          <div className="field">
            <label htmlFor="ytid">YouTube channel id (optional)</label>
            <input id="ytid" className="input mono" value={ytId} onChange={(e) => setYtId(e.target.value)} placeholder="UC…" />
          </div>
        )}
        <label className="plat-opt">
          <input type="checkbox" checked={ig} onChange={(e) => setIg(e.target.checked)} />
          <span className="col" style={{ gap: 2 }}>
            <span style={{ fontWeight: 500 }}>Instagram Reels</span>
            <span className="xs t3">Same bundle, 9:16, captions burned in. The account id is added on Channels once you have it.</span>
          </span>
          <span className="pill s-rev nodot">manual posting until Meta app review clears</span>
        </label>
      </section>

      <section className="card card-b col" style={{ gap: 14 }}>
        <div className="row sb">
          <span className="h3">Channel accent</span>
          <span className="xs t3">The square on cards, calendar slots and chart lines</span>
        </div>
        <div className="row" style={{ gap: 10 }} role="radiogroup" aria-label="Channel accent">
          {CHANNEL_ACCENTS.map((a) => (
            <button
              key={a.hex}
              type="button"
              role="radio"
              aria-checked={accent === a.hex}
              aria-label={a.name}
              className={`swatch${accent === a.hex ? ' on' : ''}`}
              style={{ background: a.hex, width: 44, height: 44 }}
              onClick={() => setAccent(a.hex)}
            />
          ))}
          <span className="mono xs t3" style={{ marginLeft: 8 }}>
            {CHANNEL_ACCENTS.find((a) => a.hex === accent)?.name}
          </span>
        </div>
        <div className="inset" style={{ padding: 14, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
          <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
            <div className="av" style={{ '--ch': accent } as CSSProperties} aria-hidden="true">
              {initials || '—'}
            </div>
            <div className="col" style={{ gap: 0 }}>
              <span className="sm" style={{ fontWeight: 600 }}>
                {name || 'Channel name'}
              </span>
              <span className="mono xs t3">{handle || '@handle'}</span>
            </div>
          </div>
          <svg viewBox="0 0 160 40" width="160" height="40" aria-hidden="true">
            <path d="M2 34 L30 26 L58 30 L86 14 L114 18 L158 6" fill="none" stroke={accent} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        {clash && (
          <div className="note">
            <span>Another channel already uses this accent. Pick a different one so the All channels view stays readable.</span>
          </div>
        )}
      </section>

      <Outcome r={r} />
      <div className="row" style={{ gap: 10 }}>
        <button className="btn pri lg" type="button" disabled={pending || name.trim().length < 2 || (!yt && !ig)} onClick={submit}>
          {pending ? 'Creating…' : 'Create channel'}
        </button>
        <span className="xs t3">Creates the row, its policy, its publish targets and a bible with the template cast. Spends nothing.</span>
      </div>
    </div>
  );
}

export function LockVoiceForm({ channelId, slug, name, presets, current }: { channelId: string; slug: string; name: string; presets: readonly string[]; current: string | null }) {
  const router = useRouter();
  const [preset, setPreset] = useState(current ?? '');
  const [r, setR] = useState<Result>(null);
  const [pending, start] = useTransition();
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="field">
        <label htmlFor={`preset-${slug}`}>Voice preset for {name}</label>
        <select id={`preset-${slug}`} className="input mono" value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="">— pick a preset —</option>
          {presets.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      <button
        className="btn pri"
        type="button"
        disabled={pending || !preset || preset === current}
        onClick={() =>
          start(async () => {
            const res = await lockVoiceAction(channelId, slug, preset);
            setR(res);
            if (res.ok) router.refresh();
          })
        }
      >
        {pending ? 'Locking…' : current ? 'Change locked voice' : 'Lock voice'}
      </button>
      <Outcome r={r} />
    </div>
  );
}

export function CapsForm({ channelId, caps }: { channelId: string; caps: { daily: number | null; monthly: number | null; perShort: number | null; longform: number | null } }) {
  const router = useRouter();
  const [d, setD] = useState(caps.daily?.toString() ?? '');
  const [m, setM] = useState(caps.monthly?.toString() ?? '');
  const [v, setV] = useState(caps.perShort?.toString() ?? '');
  const [l, setL] = useState(caps.longform?.toString() ?? '');
  const [r, setR] = useState<Result>(null);
  const [pending, start] = useTransition();
  const n = (s: string) => (s.trim() === '' ? null : Number(s));
  const bad = n(v) !== null && n(d) !== null && n(v)! > n(d)!;
  const over = n(d) !== null && n(m) !== null && n(d)! * 31 > n(m)!;
  const field = (id: string, label: string, val: string, set: (s: string) => void) => (
    <div className="cap field">
      <label className="xs t2" htmlFor={id}>
        {label}
      </label>
      <div className="in">
        <span className="t3">₹</span>
        <input id={id} inputMode="decimal" value={val} onChange={(e) => set(e.target.value.replace(/[^0-9.]/g, ''))} />
      </div>
    </div>
  );
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="kgrid ga-160">
        {field('cd', 'Daily', d, setD)}
        {field('cm', 'Monthly', m, setM)}
        {field('cv', 'Per Short', v, setV)}
        {field('cl', 'Long-form day', l, setL)}
      </div>
      <div className="inset" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row sb sm">
          <span className="t2">Daily cap × 31 days</span>
          <span className="mono">{n(d) === null ? '—' : `₹${(n(d)! * 31).toLocaleString('en-IN')}`}</span>
        </div>
      </div>
      {over && !bad && (
        <div className="note">
          <span>Your daily cap allows more than your monthly cap over a full month. That’s fine — Kiln stops at whichever cap is hit first.</span>
        </div>
      )}
      {bad && (
        <div className="blocker" role="alert">
          <span aria-hidden="true" className="tblk">
            !
          </span>
          <p>The per-Short cap is above the daily cap, so a single Short could use the whole day.</p>
        </div>
      )}
      <Outcome r={r} />
      <div className="row" style={{ gap: 10 }}>
        <button
          className="btn pri"
          type="button"
          disabled={pending || bad || [d, m, v, l].every((x) => x.trim() === '')}
          onClick={() =>
            start(async () => {
              const caps: Record<string, number> = {};
              if (n(d) !== null) caps.daily_cap_inr = n(d)!;
              if (n(m) !== null) caps.monthly_cap_inr = n(m)!;
              if (n(v) !== null) caps.per_short_cap_inr = n(v)!;
              if (n(l) !== null) caps.daily_longform_cap_inr = n(l)!;
              const res = await updatePolicyAction(channelId, { caps });
              setR(res);
              if (res.ok) router.refresh();
            })
          }
        >
          {pending ? 'Saving…' : 'Save caps'}
        </button>
        <span className="xs t3">Approver only. Logged verbatim in the authorship log.</span>
      </div>
    </div>
  );
}

export function TrendsForm({ channelId, subreddits, youtube }: { channelId: string; subreddits: string[]; youtube: { region_code: string; category_ids: string[]; queries: string[] } | null }) {
  const router = useRouter();
  const [subs, setSubs] = useState(subreddits);
  const [draft, setDraft] = useState('');
  const [r, setR] = useState<Result>(null);
  const [pending, start] = useTransition();
  const add = () => {
    const s = draft.replace(/^\/?r\//i, '').trim();
    if (!s || subs.includes(s)) return setDraft('');
    setSubs([...subs, s]);
    setDraft('');
  };
  return (
    <div className="col" style={{ gap: 12 }}>
      <span className="lbl">Subreddits</span>
      <div className="row" style={{ gap: 6 }}>
        {subs.length === 0 && <span className="xs t3">None yet — trend intake for this channel reads YouTube only, or nothing.</span>}
        {subs.map((s) => (
          <span className="tg" key={s}>
            r/{s}
            <button type="button" aria-label={`Remove r/${s}`} onClick={() => setSubs(subs.filter((x) => x !== s))}>
              ×
            </button>
          </span>
        ))}
        <label className="sr-only" htmlFor="sr-add">
          Add subreddit
        </label>
        <input
          id="sr-add"
          className="input mono"
          placeholder="r/…"
          style={{ width: 160, height: 32 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn sm" type="button" onClick={add}>
          Add
        </button>
      </div>
      <span className="xs t3">
        YouTube: {youtube ? `region ${youtube.region_code}, ${youtube.category_ids.length} categor${youtube.category_ids.length === 1 ? 'y' : 'ies'}, ${youtube.queries.length} quer${youtube.queries.length === 1 ? 'y' : 'ies'}` : 'off'} — kept as it is.
      </span>
      <Outcome r={r} />
      <div>
        <button
          className="btn"
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await updateTrendSourcesAction(channelId, { subreddits: subs, youtube });
              setR(res);
              if (res.ok) router.refresh();
            })
          }
        >
          {pending ? 'Saving…' : 'Save trend sources'}
        </button>
      </div>
    </div>
  );
}
