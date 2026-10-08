import type { ReactNode } from 'react';

/**
 * An orb card (Kiln Glass "Needs you"): a glass card lit from one corner by its tone —
 * `alert` (red, with the ping) for something stopped, warm for something waiting on you,
 * `calm` (blue) for something you can do when you like.
 */
export function Orb({
  tone,
  label,
  channel,
  what,
  why,
  meta,
  actions,
  read,
}: {
  tone: 'alert' | 'warm' | 'calm';
  label: string;
  channel?: { initials: string; alt?: boolean } | null;
  what: ReactNode;
  why?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Already read: dimmed, no ping. */
  read?: boolean;
}) {
  return (
    <article className={`orb${tone === 'warm' ? '' : ` ${tone}`}${read ? ' read' : ''}`}>
      <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
        {tone === 'alert' && !read && <span className="ping" aria-hidden="true" />}
        <span className={`lb ${tone}`}>{label}</span>
        {channel && (
          <span className={`cav sm${channel.alt ? ' alt' : ''}`} aria-hidden="true" style={{ marginLeft: 'auto' }}>
            {channel.initials}
          </span>
        )}
      </div>
      <span className="what">{what}</span>
      {why && <span className="why">{why}</span>}
      {meta && <span className="meta">{meta}</span>}
      {actions && (
        <div className="row" style={{ gap: 8 }}>
          {actions}
        </div>
      )}
    </article>
  );
}
