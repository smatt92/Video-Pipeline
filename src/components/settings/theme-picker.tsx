'use client';

import { useState, useTransition } from 'react';

import { Chain } from '@/components/glass/chain';
import { DotMatrix } from '@/components/glass/dot-matrix';
import { KillSwitch } from '@/components/glass/kill-switch';
import { Orb } from '@/components/glass/orb';
import { Icon } from '@/components/ui/icon';
import { Pill } from '@/components/ui/tags';
import { setAppearanceAction } from '@/lib/appearance/actions';
import { THEMES, type Surface, type ThemeId } from '@/styles/themes';

/**
 * Settings → Appearance (canvas: GlassThemes). Six cards, each a swatch of its own gradient
 * (`data-palette` scopes the theme to the card), and the Glass / Solid toggle.
 *
 * Picking applies at once: the attribute is written on <html> in the browser — the whole app
 * behind the picker IS the live preview — and the cookie is set by a Server Action so the next
 * request renders in the same theme from its first byte.
 */
export function Appearance({ theme, surface }: { theme: ThemeId; surface: Surface }) {
  const [cur, setCur] = useState(theme);
  const info = THEMES.find((t) => t.id === cur) ?? THEMES[0]!;
  return (
    <div className="appearance">
      <Preview name={info.name} blurb={info.blurb} />
      <ThemePicker cur={cur} onPick={setCur} surface={surface} />
    </div>
  );
}

/**
 * The live preview: the shared components in the theme just picked. Its figures are samples
 * and it says so — a number on a settings page must not be mistaken for this month's spend.
 */
function Preview({ name, blurb }: { name: string; blurb: string }) {
  return (
    <section className="col" style={{ gap: 20, minWidth: 0 }} aria-label="Preview">
      <div className="col" style={{ gap: 6 }}>
        <span className="lb">Settings · Appearance · colour theme</span>
        <span className="disp" style={{ fontSize: 'calc(64px * var(--ui-scale))' }}>{name} glass</span>
        <span className="t2" style={{ fontSize: 'var(--type-lg)', maxWidth: 560 }}>
          {blurb}
        </span>
        <span className="xs t3">Preview — sample figures, not your channel’s.</span>
      </div>
      <div className="kgrid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 16 }}>
        <div className="gp hero">
          <div className="row sb">
            <span className="lb">Spend this month</span>
            <span className="mono xs t3">of ₹30,000</span>
          </div>
          <span className="disp num xl">₹6,412</span>
          <DotMatrix values={[1, 2, 1, 3, 2, 2, 3, 2, 4, 3, 2, 3, 5, 3, 2, 4]} label="Sample: daily spend" />
        </div>
        <div className="gp hero">
          <span className="lb">Cost per video</span>
          <span className="disp num unk">—</span>
          <span className="xs t3">No video has finished yet.</span>
        </div>
      </div>
      <div className="gp col" style={{ padding: '20px 22px', gap: 16 }}>
        <div className="row sb" style={{ gap: 12 }}>
          <nav className="tabs" aria-label="Sample sections">
            <span className="on">Home</span>
            <span>Studio</span>
            <span>Approvals</span>
            <span>Cuts</span>
          </nav>
          <div className="seg" role="group" aria-label="Sample motion">
            <button type="button" className="on" tabIndex={-1}>
              Key
            </button>
            <button type="button" tabIndex={-1}>
              Full
            </button>
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className="pbtn">Draft brief · ₹4–8</span>
          <span className="gbtn">Ideas from trends</span>
          <span className="ibtn" aria-label="Sample: notifications, 3 unread" role="img">
            <Icon name="bell" />
            <span className="badge">3</span>
          </span>
          <KillSwitch kill={{ on: false, reason: null }} channelId={null} preview />
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Pill tone="draft">Draft</Pill>
          <Pill tone="gen">Generating</Pill>
          <Pill tone="rev">Needs review</Pill>
          <Pill tone="blk">Blocked</Pill>
          <Pill tone="rdy">Ready</Pill>
          <Pill tone="live">Live</Pill>
        </div>
        <Chain
          nodes={[
            { stage: 'brief', state: 'ok', cost: '₹5' },
            { stage: 'voice', state: 'ok', cost: '₹24' },
            { stage: 'pictures', state: 'run', cost: '₹18', label: 'Pictures 4/12' },
            { stage: 'clips', state: 'idle', cost: null },
            { stage: 'cut', state: 'idle', cost: null },
            { stage: 'bundle', state: 'idle', cost: null },
          ]}
        />
      </div>
      <div className="kgrid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 16 }}>
        <Orb tone="alert" label="Fallback needs approval" what="3D explainer could not be made: no hero-object sheet." actions={<span className="pbtn" style={{ height: 40 }}>Run as illustrated</span>} />
        <Orb tone="calm" label="Cut ready" what="Lift safety brakes · 41 s · −16 LUFS" actions={<span className="pbtn" style={{ height: 40 }}>Watch</span>} />
      </div>
    </section>
  );
}

function ThemePicker({ cur, onPick, surface }: { cur: ThemeId; onPick: (t: ThemeId) => void; surface: Surface }) {
  const [surf, setSurf] = useState(surface);
  const [msg, setMsg] = useState<string | null>(null);
  const [, start] = useTransition();

  const pick = (id: ThemeId) => {
    onPick(id);
    document.documentElement.dataset.theme = id;
    start(async () => setMsg((await setAppearanceAction({ theme: id })).message));
  };
  const setSurface = (s: Surface) => {
    setSurf(s);
    document.documentElement.classList.toggle('solid', s === 'solid');
    start(async () => setMsg((await setAppearanceAction({ surface: s })).message));
  };

  return (
    <aside className="gp dense col" style={{ padding: 22, gap: 16 }} aria-label="Colour theme">
      <div className="col" style={{ gap: 4 }}>
        <h2 className="h2">Colour theme</h2>
        <p className="xs t3">Every theme is a gradient on graphite glass. Status colours keep their meaning in all of them.</p>
      </div>
      <div className="kgrid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }} role="radiogroup" aria-label="Colour theme">
        {THEMES.map((t) => {
          const on = t.id === cur;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-palette={t.id}
              className={`tcard gp s${on ? ' sel' : ''}`}
              onClick={() => pick(t.id)}
            >
              <span className="swb" aria-hidden="true" />
              <span className="row sb" style={{ flexWrap: 'nowrap' }}>
                <span className="h3">{t.name}</span>
                <span className="mono xs t3">{t.tag}</span>
              </span>
              <span className="mono xs t3">{t.stops.join(' → ')}</span>
            </button>
          );
        })}
      </div>
      <div className="row sb" style={{ paddingTop: 4 }}>
        <span className="sm t2">Reduce transparency</span>
        <div className="seg" role="group" aria-label="Reduce transparency">
          <button type="button" className={surf === 'glass' ? 'on' : undefined} aria-pressed={surf === 'glass'} onClick={() => setSurface('glass')}>
            Glass
          </button>
          <button type="button" className={surf === 'solid' ? 'on' : undefined} aria-pressed={surf === 'solid'} onClick={() => setSurface('solid')}>
            Solid
          </button>
        </div>
      </div>
      <p className="xs t3" role="status">
        {msg ?? 'Saved per browser. Solid also follows your system’s Reduce transparency setting.'}
      </p>
    </aside>
  );
}
