import type { CSSProperties, ReactNode } from 'react';

/**
 * Loading skeletons (08-Oct). Each app screen's `loading.tsx` composes these into the shape of
 * that screen — the same header, cards and columns, so the page that replaces it lands where
 * the eye already is instead of a spinner in the middle of nothing.
 *
 * Server Components, no client JS. The shimmer is CSS (`.skel` in kiln.css) and stops under
 * reduced motion. The real title is printed, not a bar: the crumb and the title are known
 * before any data is, and reading "Approvals" the instant you tap is the point.
 *
 * `data-skeleton` on the root is load-bearing: the top progress bar (nav-feedback.tsx) keeps
 * running until no element carries it, i.e. until the screen's real content is in.
 */

export function Bar({ w = '100%', h = 12, r, style, ink }: { w?: number | string; h?: number; r?: boolean; style?: CSSProperties; ink?: boolean }) {
  return <span className={`skel${r ? ' r' : ''}${ink ? ' ink' : ''}`} style={{ width: w, height: h, ...style }} aria-hidden="true" />;
}

export function Lines({ widths, h = 11, gap = 8 }: { widths: (number | string)[]; h?: number; gap?: number }) {
  return (
    <span className="skel-line" style={{ gap }}>
      {widths.map((w, i) => (
        <Bar key={i} w={w} h={h} />
      ))}
    </span>
  );
}

/** A card with a header row and a body of lines (or anything). */
export function SkelCard({ title = true, rows = 3, children, style, className = '' }: { title?: boolean; rows?: number; children?: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <section className={`card ${className}`.trim()} style={style} aria-hidden="true">
      {title && (
        <div className="card-h">
          <Bar w={120} h={13} />
          <Bar w={56} h={11} />
        </div>
      )}
      <div className="card-b col" style={{ gap: 12 }}>
        {children ?? <Lines widths={Array.from({ length: rows }, (_, i) => ['92%', '74%', '86%', '60%', '80%'][i % 5]!)} />}
      </div>
    </section>
  );
}

/** A list row: a dot or square, a title line, a meta line, a pill on the right. */
export function SkelRow() {
  return (
    <div className="row sb" style={{ flexWrap: 'nowrap', padding: '12px 16px', borderBottom: '1px solid var(--b1)' }} aria-hidden="true">
      <span className="row" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0, flex: '1 1 auto' }}>
        <Bar w={10} h={10} style={{ borderRadius: 3, flex: 'none' }} />
        <span className="col" style={{ gap: 6, flex: '1 1 auto', minWidth: 0 }}>
          <Bar w="58%" h={12} />
          <Bar w="34%" h={10} />
        </span>
      </span>
      <Bar w={64} h={20} r style={{ flex: 'none' }} />
    </div>
  );
}

/**
 * The screen frame: the same two headers ScreenHeader renders (desktop topbar, phone ph-top),
 * with the crumb and title written and the data-bearing line as a bar.
 */
export function SkelScreen({ crumb, title, mobileTitle, actions = 0, children }: { crumb: string; title: string; mobileTitle?: string; actions?: number; children: ReactNode }) {
  return (
    <main className="main" data-skeleton="" aria-busy="true" aria-label={`Loading ${title}`}>
      <header className="topbar desk-only">
        <div className="col" style={{ gap: 0, minWidth: 0 }}>
          <div className="crumb">
            <span className="chm" aria-hidden="true" />
            <Bar w={96} h={10} />
            <span className="t3" aria-hidden="true">
              /
            </span>
            <span>{crumb}</span>
          </div>
          <h1 className="h1">{title}</h1>
          <Bar w={180} h={11} style={{ marginTop: 8 }} />
        </div>
        {actions > 0 && (
          <div className="row" style={{ gap: 10 }}>
            {Array.from({ length: actions }, (_, i) => (
              <Bar key={i} w={i === actions - 1 ? 110 : 72} h={40} style={{ borderRadius: 999 }} />
            ))}
          </div>
        )}
      </header>
      <header className="ph-top mob-only">
        <div className="col grow" style={{ gap: 4 }}>
          <h1 className="ttl">{mobileTitle ?? title}</h1>
          <Bar w={140} h={10} />
        </div>
      </header>
      {children}
      <span className="sr-only" role="status">
        Loading {title}…
      </span>
    </main>
  );
}

/** A grid of small stat cards (Home's "what needs you", Metrics' KPIs, Costs' tiles). */
export function SkelTiles({ n = 3, min = 220, h = 92 }: { n?: number; min?: number; h?: number }) {
  return (
    <div className={`kgrid ga-${min}`}>
      {Array.from({ length: n }, (_, i) => (
        <section className="card card-b col" style={{ gap: 10, minHeight: h }} key={i} aria-hidden="true">
          <Bar w={34} h={22} />
          <Bar w="62%" h={12} />
          <Bar w="40%" h={10} />
        </section>
      ))}
    </div>
  );
}

/** A card holding rows — the Board's phone list, Ready's fields, a Library table. */
export function SkelList({ rows = 5, title = true }: { rows?: number; title?: boolean }) {
  return (
    <section className="card" style={{ overflow: 'hidden' }} aria-hidden="true">
      {title && (
        <div className="card-h">
          <Bar w={140} h={13} />
          <Bar w={48} h={11} />
        </div>
      )}
      {Array.from({ length: rows }, (_, i) => (
        <SkelRow key={i} />
      ))}
    </section>
  );
}

/** One kanban column of the Board: header with a dot, then cards. */
export function SkelColumn({ cards = 2 }: { cards?: number }) {
  return (
    <section className="kcol" style={{ minHeight: 420 }} aria-hidden="true">
      <div className="kcol-h">
        <Bar w={8} h={8} r />
        <Bar w={92} h={11} />
      </div>
      {Array.from({ length: cards }, (_, i) => (
        <div className="kcard" key={i}>
          <div className="row sb" style={{ flexWrap: 'nowrap' }}>
            <Bar w={52} h={13} />
            <Bar w={30} h={30} style={{ borderRadius: 8 }} />
          </div>
          <Lines widths={['90%', '64%']} />
          <Bar h={4} />
        </div>
      ))}
    </section>
  );
}

/** A 9:16 player frame (Cuts, Review). */
export function SkelPlayer() {
  return (
    <div style={{ width: 'min(100%, 320px)', aspectRatio: '9 / 16', borderRadius: 'var(--r3)', overflow: 'hidden', border: '1px solid var(--b1)' }} aria-hidden="true">
      <Bar w="100%" h={0} style={{ height: '100%', borderRadius: 0 }} />
    </div>
  );
}
