import type { ReactNode } from 'react';

import { initials } from '@/lib/shell/initials';

import { MobileSearch } from './mobile-search';

/**
 * Page header for the redesigned screens. Desktop: the canvas topbar — crumb with the channel
 * square and name, the title, actions on the right. Phone: the canvas `ph-top` — channel
 * avatar, title with one line under it, search. One component so the two never drift apart.
 */
export function ScreenHeader({
  channel,
  crumb,
  title,
  sub,
  actions,
  mobileTitle,
}: {
  channel: { name: string } | null;
  crumb: string;
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  mobileTitle?: ReactNode;
}) {
  return (
    <>
      <header className="topbar desk-only">
        <div className="col" style={{ gap: 0, minWidth: 0 }}>
          <div className="crumb">
            {channel ? (
              <>
                <span className="chm" aria-hidden="true" />
                <span>{channel.name}</span>
              </>
            ) : (
              <span>All channels</span>
            )}
            <span className="t3" aria-hidden="true">
              /
            </span>
            <span>{crumb}</span>
          </div>
          <h1 className="h1">{title}</h1>
          {sub && <p className="sm t3" style={{ marginTop: 4 }}>{sub}</p>}
        </div>
        {actions && (
          <div className="row" style={{ gap: 10 }}>
            {actions}
          </div>
        )}
      </header>
      <header className="ph-top mob-only">
        <div className={channel ? 'av' : 'av all'} aria-hidden="true">
          {channel ? initials(channel.name) : '∗'}
        </div>
        <div className="col grow" style={{ gap: 0 }}>
          <h1 className="ttl">{mobileTitle ?? title}</h1>
          {sub && <span className="xs t3">{sub}</span>}
        </div>
        <MobileSearch />
      </header>
    </>
  );
}
