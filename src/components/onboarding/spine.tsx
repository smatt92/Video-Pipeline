import Link from 'next/link';
import type { ReactNode } from 'react';

import { Icon } from '@/components/ui/icon';
import { Lockup } from '@/components/ui/logo';
import type { Spine } from '@/lib/onboarding/spine';

/**
 * Setup frame (canvas: OnbSpine + Onb-*): the spine on the left — ten pages in four groups,
 * a segment bar, and what blocks the first video, one sentence each — and the step beside it.
 * On a phone the spine folds into a top bar with the same segment bar and the blocker count.
 */

const GROUP_TITLE = (g: string, channel: string | null) => (g === 'Channel' ? `Channel${channel ? ` · ${channel}` : ''}` : g);

function SpineNav({ spine }: { spine: Spine }) {
  const cur = spine.items.find((i) => i.state === 'cur');
  const groups = ['Studio', 'Channel', 'Optional', 'Finish'] as const;
  return (
    <nav className="sp" aria-label="Setup progress">
      <div className="row sb">
        <Link href="/home" style={{ textDecoration: 'none' }} aria-label="Kiln home">
          <Lockup fontSize={18} />
        </Link>
        <span className="mono xs t3">{cur ? `step ${cur.page.n} of 10` : 'resume'}</span>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <Segbar spine={spine} />
        <span className="xs t3">Saved on every Save and test · resume any time</span>
      </div>
      {groups.map((g) => (
        <div className="sg" key={g}>
          <span className="lbl" style={{ padding: '0 10px 6px' }}>
            {GROUP_TITLE(g, spine.channel?.name ?? null)}
          </span>
          {spine.items
            .filter((i) => i.page.group === g)
            .map((i) => (
              <Link
                key={i.page.slug}
                href={`/setup/${i.page.slug}`}
                className={`si${i.state === 'done' ? ' done' : i.state === 'cur' ? ' cur' : ''}${i.page.optional ? ' opt' : ''}${i.state === 'lock' ? ' lock' : ''}`}
                aria-current={i.state === 'cur' ? 'step' : undefined}
              >
                <span className="mk" aria-hidden="true">
                  {i.state === 'done' ? '✓' : i.page.n}
                </span>
                <span className="col" style={{ gap: 1 }}>
                  <span className="t">
                    {i.page.label}
                    <span className="sr-only">{i.state === 'done' ? ' — done' : i.state === 'lock' ? ' — locked' : i.state === 'skip' ? ' — skipped' : ''}</span>
                  </span>
                  <span className="s">{i.sub}</span>
                </span>
              </Link>
            ))}
        </div>
      ))}
      <Blockers spine={spine} />
    </nav>
  );
}

export function Segbar({ spine }: { spine: Spine }) {
  return (
    <div className="segbar" role="img" aria-label={`${spine.doneCount} of ${spine.items.length} setup pages done`}>
      {spine.items.map((i) => (
        <span key={i.page.slug} className={i.state === 'done' ? 'd' : i.state === 'cur' ? 'c' : i.page.optional ? 'o' : undefined} />
      ))}
    </div>
  );
}

export function Blockers({ spine }: { spine: Spine }) {
  if (spine.blockers.length === 0) {
    return (
      <div className="card" style={{ padding: '12px 14px', borderColor: 'var(--live-line)' }}>
        <span className="sm">Nothing blocks your first video.</span>
      </div>
    );
  }
  return (
    <div className="card" style={{ padding: '12px 14px', borderColor: 'var(--blk-line)', background: 'var(--blk-wash)' }}>
      <span className="lbl" style={{ color: 'var(--blk-text)' }}>
        Blocks your first video · {spine.blockers.length}
      </span>
      {spine.blockers.slice(0, 3).map((b) => (
        <Link className="bl" href={`/setup/${b.slug}`} key={b.slug}>
          <i aria-hidden="true" />
          <span>{b.text}</span>
        </Link>
      ))}
      {spine.blockers.length > 3 && <span className="xs t3">+ {spine.blockers.length - 3} more after these</span>}
    </div>
  );
}

export function SetupFrame({ spine, children }: { spine: Spine; children: ReactNode }) {
  const cur = spine.items.find((i) => i.state === 'cur');
  return (
    <div className="ob">
      <div className="ob-spine">
        <SpineNav spine={spine} />
      </div>
      <div style={{ flex: '999 1 560px', minWidth: 0 }}>
        <div className="ob-top">
          <div className="row sb">
            <Link className="btn icon" href="/setup" aria-label="Setup overview" style={{ width: 44, height: 44 }}>
              <Icon name="back" />
            </Link>
            <span className="mono xs t3">{cur ? `${cur.page.group} · ${cur.page.n} of 10` : 'Setup'}</span>
            <Link className="xs tlink" href="/setup">
              {spine.blockers.length} blocker{spine.blockers.length === 1 ? '' : 's'}
            </Link>
          </div>
          <Segbar spine={spine} />
        </div>
        <main className="ob-main" id="content">
          <div className="ob-col">{children}</div>
        </main>
      </div>
    </div>
  );
}
