import Link from 'next/link';

import { Icon } from '@/components/ui/icon';

/**
 * The Studio's own header row (canvas: GlassStudio): Back, the Create / Sessions pill tabs,
 * and the contextual pill — Open on Approvals → Watch cut → Bundle on Ready — which always
 * names the next thing the newest video needs and, while nothing can be opened yet, says
 * when it will be.
 */
export type NextStep =
  | { kind: 'approve'; briefId: string }
  | { kind: 'cut'; episodeId: string }
  | { kind: 'ready' }
  | { kind: 'wait'; label: string; why: string };

export function StudioHeader({ tab, back, next, title }: { tab: 'create' | 'sessions' | null; back: { href: string; label: string }; next: NextStep; title?: string | null }) {
  return (
    <header className="studio-head">
      <Link className="gbtn" href={back.href}>
        <Icon name="back" />
        {back.label}
      </Link>
      <nav className="tabs" aria-label="Studio">
        <Link href="/studio" className={tab === 'create' ? 'on' : undefined} aria-current={tab === 'create' ? 'page' : undefined}>
          Create
        </Link>
        <Link href="/studio?tab=sessions" className={tab === 'sessions' ? 'on' : undefined} aria-current={tab === 'sessions' ? 'page' : undefined}>
          Sessions
        </Link>
      </nav>
      <div className="col studio-next">
        {next.kind === 'approve' && (
          <Link className="pbtn" href={`/bureau/approvals?id=${next.briefId}`} style={{ height: 40 }}>
            Open on Approvals
          </Link>
        )}
        {next.kind === 'cut' && (
          <Link className="pbtn" href={`/bureau/cuts?id=${next.episodeId}`} style={{ height: 40 }}>
            Watch cut
          </Link>
        )}
        {next.kind === 'ready' && (
          <Link className="pbtn" href="/bureau/ready" style={{ height: 40 }}>
            Bundle on Ready
          </Link>
        )}
        {next.kind === 'wait' && (
          <>
            <button type="button" className="pbtn off" disabled style={{ height: 40 }}>
              {next.label}
            </button>
            <span className="mono xs t3">{next.why}</span>
          </>
        )}
      </div>
      {title && <span className="mono xs studio-title">{title}</span>}
    </header>
  );
}
