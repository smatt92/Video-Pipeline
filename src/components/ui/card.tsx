import type { CSSProperties, ReactNode } from 'react';

import { Icon } from './icon';
import { Basis } from './tags';

/** Surfaces (canvas: Components). Card = s1 with the inset highlight; inset = the well. */
export function Card({ children, className = '', style, as: Tag = 'section', ...rest }: { children: ReactNode; className?: string; style?: CSSProperties; as?: 'section' | 'div' | 'article'; 'aria-label'?: string }) {
  return (
    <Tag className={`card ${className}`.trim()} style={style} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, right, level = 2 }: { title: ReactNode; right?: ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className="card-h">
      <H className="h3">{title}</H>
      {right}
    </div>
  );
}

export function CardBody({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`card-b ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}

/**
 * Format rupees for display. Two decimals under ₹100 (a ledger row is often paise), none above.
 * Takes a number that is already a number — `Number()` belongs in the row mapper, not here.
 */
export function inr(n: number): string {
  const abs = Math.abs(n);
  const digits = abs < 100 ? 2 : 0;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/**
 * Stat tile. `value: null` is absent, never zero: the tile shows an em dash and the reason,
 * because a missing measurement rendered as 0 is silently believed and summed.
 */
export function StatTile({
  label,
  value,
  unit,
  why,
  basis,
  right,
  bar,
  className = '',
}: {
  label: ReactNode;
  value: ReactNode | null;
  unit?: ReactNode;
  /** One line under the number. Required when `value` is null — it is the reason. */
  why: ReactNode;
  basis?: 'est' | 'meas';
  right?: ReactNode;
  /** 0–1 share of a cap, drawn as the thin bar. */
  bar?: { share: number; tone?: 'rev' | 'blk' } | null;
  className?: string;
}) {
  return (
    <div className={`card tile ${className}`.trim()}>
      <div className="row sb">
        <span className="lbl">{label}</span>
        {right ?? (basis && value !== null ? <Basis kind={basis} /> : null)}
      </div>
      {value === null ? (
        <span className="unk" aria-label="unknown">
          —
        </span>
      ) : (
        <span className="tv">
          {value}
          {unit && <small>{unit}</small>}
        </span>
      )}
      {bar && (
        <div className={`bar${bar.tone ? ` ${bar.tone}` : ''}`} role="presentation">
          <i style={{ width: `${Math.max(0, Math.min(1, bar.share)) * 100}%` }} />
        </div>
      )}
      <span className="why">{why}</span>
    </div>
  );
}

/** One plain sentence and one action. The action is the fix, not "learn more". */
export function Blocker({ children, action, subject, wrap }: { children: ReactNode; action?: ReactNode; subject?: ReactNode; wrap?: boolean }) {
  return (
    <div className={`blocker${wrap ? ' wrap' : ''}`} role="status">
      <Icon name="warn" />
      <p>
        {subject && (
          <>
            <b className="mono">{subject}</b> ·{' '}
          </>
        )}
        {children}
      </p>
      {action}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="note">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  );
}

export function Empty({ title, children, unknown }: { title?: ReactNode; children?: ReactNode; unknown?: boolean }) {
  return (
    <div className="empty">
      {unknown && (
        <span className="unk" style={{ fontSize: 22 }}>
          —
        </span>
      )}
      {title && <span style={{ color: 'var(--t2)', fontWeight: 500 }}>{title}</span>}
      {children && <span>{children}</span>}
    </div>
  );
}

/** Table shell: mono numerals, right-aligned ₹ (`className="r mono"` on the cell). */
export function Table({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div className="scroll-x">
      <table className="tbl" aria-label={label}>
        {children}
      </table>
    </div>
  );
}

/** Page header: crumb, title, one line under it, actions right. */
export function PageHeader({ crumb, title, sub, actions }: { crumb?: ReactNode; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="col" style={{ gap: 4, minWidth: 0 }}>
        {crumb && <div className="crumb">{crumb}</div>}
        <h1 className="h1">{title}</h1>
        {sub && <p className="sm t3">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}
