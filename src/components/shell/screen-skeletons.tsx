import { Bar, Lines, SkelCard, SkelColumn, SkelList, SkelPlayer, SkelRow, SkelScreen, SkelTiles } from './skeleton';

/**
 * One skeleton per screen family, each shaped like its screen (see skeleton.tsx for why).
 * The `loading.tsx` beside each route renders one of these and nothing else.
 */

export function HomeSkeleton() {
  // The real screen: the next-slot hero (blueprint card) beside "Needs you" and "Coming up",
  // then "Episodes in production" as cards beside "Spend vs cap".
  return (
    <SkelScreen crumb="Home" title="Home" actions={3}>
      <div className="split">
        <div className="wide">
          <section className="card bp" style={{ minHeight: 328, padding: '28px 28px 28px 24px', display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }} aria-hidden="true">
            <div style={{ flex: '1 1 260px', maxWidth: 400, aspectRatio: '4 / 3', borderRadius: 14, border: '1px dashed var(--b2)' }} />
            <div className="col" style={{ flex: '1 1 260px', gap: 14, minWidth: 0 }}>
              <div className="row sb">
                <Bar w={72} h={10} />
                <Bar w={96} h={22} r />
              </div>
              <Bar w="70%" h={16} />
              <Bar w="82%" h={40} />
              <Bar w="60%" h={11} />
              <div className="row" style={{ gap: 8 }}>
                <Bar w={84} h={28} r />
                <Bar w={84} h={28} r />
              </div>
            </div>
          </section>
        </div>
        <div className="side">
          <SkelList rows={3} />
          <SkelList rows={3} />
        </div>
      </div>
      <div className="split">
        <div className="wide">
          <SkelCard title rows={0}>
            <div className="kgrid ga-300">
              {[0, 1].map((i) => (
                <div className="kcard" key={i} aria-hidden="true">
                  <div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
                    <Bar w={40} h={40} style={{ borderRadius: 10, flex: 'none' }} />
                    <span className="col grow" style={{ gap: 8 }}>
                      <Bar w="40%" h={13} />
                      <Bar w="90%" h={11} />
                    </span>
                  </div>
                  <Bar h={4} />
                </div>
              ))}
            </div>
          </SkelCard>
        </div>
        <div className="side">
          <SkelCard rows={4} />
        </div>
      </div>
    </SkelScreen>
  );
}

export function ApprovalsSkeleton() {
  // The real screen: the brief (slot, cast, title), the video-type choices, then the beats;
  // beside them the Decision card and the queue.
  return (
    <SkelScreen crumb="Approvals" title="Approvals" actions={2}>
      <div className="split">
        <div className="wide">
          <SkelCard title={false}>
            <div className="row sb">
              <div className="row" style={{ gap: 10 }}>
                <Bar w={52} h={18} />
                <Bar w={140} h={11} />
                <Bar w={110} h={20} style={{ borderRadius: 5 }} />
              </div>
              <Bar w={110} h={22} r />
            </div>
            <div className="row" style={{ gap: 20, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
              <Bar w={72} h={72} style={{ borderRadius: 10, flex: 'none' }} />
              <span className="col grow" style={{ gap: 10 }}>
                <Bar w="88%" h={22} />
                <Bar w="56%" h={22} />
                <Bar w="70%" h={11} />
              </span>
            </div>
            <Bar w={92} h={30} r />
          </SkelCard>
          <SkelCard title rows={0}>
            {[0, 1, 2, 3].map((i) => (
              <div className="inset" key={i} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Bar w={150} h={13} />
                <Bar w="64%" h={11} />
                <Bar w="38%" h={10} />
              </div>
            ))}
          </SkelCard>
        </div>
        <div className="side">
          <SkelCard title rows={0}>
            <Lines widths={['100%', '100%']} />
            <Bar w="50%" h={22} />
            <Bar h={78} style={{ borderRadius: 10 }} />
            <Bar h={50} style={{ borderRadius: 10 }} />
            <Bar h={36} style={{ borderRadius: 9 }} />
            <Bar h={36} style={{ borderRadius: 9 }} />
          </SkelCard>
          <SkelList rows={2} />
        </div>
      </div>
    </SkelScreen>
  );
}

export function CutsSkeleton() {
  // The real screen: a row of cut chips, then the 9:16 player, the shot list and the QC /
  // "Your call" column side by side (stacked on a phone, player first, full width).
  return (
    <SkelScreen crumb="Cuts" title="Cuts">
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap', overflow: 'hidden' }}>
        <Bar w={124} h={26} style={{ flex: 'none', borderRadius: 7 }} />
        <Bar w={132} h={26} style={{ flex: 'none', borderRadius: 7 }} />
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: '1 1 300px', maxWidth: 340, minWidth: 0 }}>
          <SkelPlayer />
        </div>
        <div className="col" style={{ flex: '999 1 300px', gap: 16, minWidth: 0 }}>
          <SkelCard rows={2} />
        </div>
        <div className="col" style={{ flex: '1 1 300px', gap: 16, minWidth: 0 }}>
          <SkelCard rows={5} />
          <SkelCard title rows={0}>
            <Bar h={48} style={{ borderRadius: 10 }} />
            <Bar h={72} style={{ borderRadius: 10 }} />
          </SkelCard>
        </div>
      </div>
    </SkelScreen>
  );
}

export function ReadySkeleton() {
  return (
    <SkelScreen crumb="Ready" title="Ready to schedule">
      <section className="card card-b" aria-hidden="true">
        <Lines widths={['96%', '58%']} />
      </section>
      {[0, 1].map((k) => (
        <div className="split" key={k}>
          <div className="wide">
            <SkelCard title rows={0}>
              {[0, 1, 2].map((i) => (
                <div className="col" key={i} style={{ gap: 8 }}>
                  <div className="row sb">
                    <Bar w={110} h={10} />
                    <Bar w={54} h={24} style={{ borderRadius: 7 }} />
                  </div>
                  <Bar w={i === 1 ? '96%' : '70%'} h={14} />
                </div>
              ))}
            </SkelCard>
          </div>
          <div className="side">
            <SkelCard title={false}>
              <Bar w={40} h={10} />
              <Bar h={36} style={{ borderRadius: 9 }} />
              <Bar h={36} style={{ borderRadius: 9 }} />
            </SkelCard>
          </div>
        </div>
      ))}
    </SkelScreen>
  );
}

export function BoardSkeleton() {
  return (
    <SkelScreen crumb="Board" title="Board" actions={3}>
      <div className="skel-kanban desk-only">
        {[2, 1, 1, 2, 1].map((n, i) => (
          <SkelColumn key={i} cards={n} />
        ))}
      </div>
      <div className="mob-only col" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 6, flexWrap: 'nowrap', overflow: 'hidden' }}>
          {[96, 72, 112, 70].map((w, i) => (
            <Bar key={i} w={w} h={36} style={{ flex: 'none', borderRadius: 999 }} />
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <div className="kcard" key={i} aria-hidden="true">
            <div className="row sb" style={{ flexWrap: 'nowrap' }}>
              <Bar w={52} h={13} />
              <Bar w={30} h={30} style={{ borderRadius: 8 }} />
            </div>
            <Lines widths={['90%', '64%']} />
            <Bar h={4} />
          </div>
        ))}
      </div>
    </SkelScreen>
  );
}

export function CalendarSkeleton() {
  return (
    <SkelScreen crumb="Calendar" title="Calendar" actions={2}>
      <section className="card card-b" aria-hidden="true">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
          {Array.from({ length: 28 }, (_, i) => (
            <Bar key={i} h={64} style={{ borderRadius: 8 }} />
          ))}
        </div>
      </section>
      <SkelList rows={3} />
    </SkelScreen>
  );
}

/** Metrics, Costs, Generation, Analytics: tiles over tables. */
export function DashboardSkeleton({ crumb, title }: { crumb: string; title: string }) {
  return (
    <SkelScreen crumb={crumb} title={title} actions={2}>
      <SkelTiles n={4} min={160} />
      <div className="split">
        <div className="wide">
          <SkelCard title rows={0}>
            <Bar h={180} style={{ borderRadius: 8 }} />
          </SkelCard>
          <SkelList rows={4} />
        </div>
        <div className="side">
          <SkelCard rows={4} />
        </div>
      </div>
    </SkelScreen>
  );
}

/** Library, Trends, Concepts, Authorship, the Script board, Review, Studio, Publish: a list. */
export function ListSkeleton({ crumb, title, rows = 6 }: { crumb: string; title: string; rows?: number }) {
  return (
    <SkelScreen crumb={crumb} title={title} actions={1}>
      <SkelList rows={rows} />
    </SkelScreen>
  );
}

/** Library screens are cards per character, voice or recipe. */
export function CardsSkeleton({ crumb, title }: { crumb: string; title: string }) {
  return (
    <SkelScreen crumb={crumb} title={title} actions={1}>
      <div className="kgrid ga-300">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkelCard key={i} rows={3} />
        ))}
      </div>
    </SkelScreen>
  );
}

/** Inside the Settings layout, which keeps its own header and tabs: just the section body. */
export function SettingsSkeleton() {
  return (
    <div className="col" style={{ gap: 16 }} data-skeleton="" aria-busy="true">
      <SkelCard rows={4} />
      <SkelCard rows={3} />
      <section className="card" aria-hidden="true">
        <SkelRow />
        <SkelRow />
      </section>
      <span className="sr-only" role="status">
        Loading settings…
      </span>
    </div>
  );
}

/** The fallback for any screen without its own: the frame and a few cards. */
export function GenericSkeleton() {
  return (
    <SkelScreen crumb="Kiln" title="Loading">
      <div className="split">
        <div className="wide">
          <SkelCard rows={4} />
          <SkelCard rows={3} />
        </div>
        <div className="side">
          <SkelCard rows={3} />
        </div>
      </div>
    </SkelScreen>
  );
}
