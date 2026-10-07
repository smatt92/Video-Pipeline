import Link from 'next/link';

import { GenerateSheet, LockSheet } from '@/components/library/character-sheet-controls';
import { LibraryHeader } from '@/components/library/library-header';
import { Bust } from '@/components/ui/bust';
import { Note } from '@/components/ui/card';
import { LockTag } from '@/components/ui/tags';
import { charactersScreen } from '@/lib/bureau/character-sheets';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { readUsdInrRate } from '@/lib/cost/fx';
import { serverClient } from '@/lib/db/server';
import { storage } from '@/lib/storage';

/**
 * Characters — each cast member's locked character sheet, for the "Cartoon characters" video
 * type (decision 0024). A character appears in a picture only when its sheet is locked; this is
 * where a sheet is generated (one image, priced on the button), looked at, and locked.
 *
 * Images are presigned GETs straight from the bucket — the bytes never pass through Vercel
 * (rule 2). Generating runs on the worker (27-character-sheet); locking is a row write.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Characters' };

async function urlFor(key: string | null): Promise<string | null> {
  if (!key) return null;
  return storage()
    .presignGet({ key, expiresIn: 3600 })
    .then((p) => p.url)
    .catch(() => null);
}

const when = (iso: string) => `${iso.slice(5, 10)} ${iso.slice(11, 16)} UTC`;

export default async function CharactersPage() {
  const channel = await requireChannel();
  const cb = bibleOrNull(channel);
  if (!cb) {
    return (
      <main className="main">
        <LibraryHeader channel={channel} active="Characters" sub="No cast yet" />
        <div className="empty" style={{ padding: 40 }}>
          <span style={{ color: 'var(--t2)', fontWeight: 500 }}>{channel.name} has no cast yet</span>
          <Link className="btn sm pri" href="/setup/cast" style={{ marginTop: 8 }}>
            Channel setup
          </Link>
        </div>
      </main>
    );
  }

  const db = serverClient();
  const fx = await readUsdInrRate(db);
  const screen = await charactersScreen(db, channel.id, cb, { usdInrRate: fx.ok ? fx.rate : null });
  const price = screen.sheetInr === null ? 'unpriced' : `₹${screen.sheetInr.toFixed(2)}`;
  const lockedUrls = await Promise.all(screen.cards.map((c) => urlFor(c.lockedKey)));
  const sheetUrls = await Promise.all(screen.cards.map((c) => Promise.all(c.sheets.map((s) => urlFor(s.storageKey)))));
  const lockedCount = screen.cards.filter((c) => c.locked).length;

  return (
    <main className="main">
      <LibraryHeader
        channel={channel}
        active="Characters"
        sub={`One locked sheet per character. In the “Cartoon characters” video type a character is drawn only from its locked sheet — one without a sheet is left out of the picture. ${lockedCount} of ${screen.cards.length} locked. A sheet is a one-time ${price}; every picture after that costs the same as an illustrated one.`}
      />
      {screen.sheetNote && <Note>Sheets cannot be priced: {screen.sheetNote}. Generating is refused until they can.</Note>}
      {!screen.canLock && <Note>This channel’s bible is not in the database yet (paste the 0048 bundle, then import it), so a sheet can be generated but not locked.</Note>}

      <section className="kgrid ga-300" aria-label="Character sheets">
        {screen.cards.map((c, i) => {
          const lockedUrl = lockedUrls[i];
          return (
            <article className="card card-b col" style={{ gap: 12 }} key={c.slug}>
              <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
                <Bust slug={c.slug} accent={c.accent} size="md" />
                <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                  <h2 className="h2">{c.name}</h2>
                  <span className="xs t3">
                    {c.role} · tag <span className="mono">@{c.tag}</span>
                    {c.objectOnly ? ' · drawn only as its object, never a body' : ''}
                  </span>
                  {c.locked ? <LockTag>sheet locked</LockTag> : <span className="pill s-blk">no locked sheet — left out of pictures</span>}
                </div>
              </div>

              {c.locked && (
                <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                  {lockedUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL; next/image would proxy the bytes through Vercel
                    <img src={lockedUrl} alt={`${c.name}'s locked sheet`} width={108} height={192} style={{ borderRadius: 8, objectFit: 'cover', background: 'var(--s2)', flex: 'none' }} />
                  ) : (
                    <span className="xs t3">Locked to {c.locked.slice(0, 60)} — not one of ours to preview.</span>
                  )}
                  <span className="xs t3">The reference every picture of {c.name} is drawn from.</span>
                </div>
              )}

              {c.sheets.length > 0 && (
                <div className="col" style={{ gap: 8 }}>
                  <span className="xs t3">Recent sheets</span>
                  <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                    {c.sheets.map((s, j) => {
                      const url = sheetUrls[i][j];
                      const isLocked = !!c.lockedKey && s.storageKey === c.lockedKey;
                      return (
                        <div className="col" style={{ gap: 4, width: 90 }} key={s.generationId}>
                          {url ? (
                            // eslint-disable-next-line @next/next/no-img-element -- presigned GET, see above
                            <img src={url} alt={`${c.name} sheet ${when(s.submittedAt)}`} width={90} height={160} style={{ borderRadius: 6, objectFit: 'cover', background: 'var(--s2)' }} />
                          ) : (
                            <span className="xs t3" style={{ width: 90, height: 160, display: 'grid', placeItems: 'center', borderRadius: 6, background: 'var(--s2)', textAlign: 'center' }}>
                              {['submitting', 'queued', 'running'].includes(s.status) ? 'drawing…' : s.status}
                            </span>
                          )}
                          <span className="xs t3">{when(s.submittedAt)}</span>
                          {s.note && <span className="xs t3">“{s.note}”</span>}
                          {s.status === 'failed' && s.reason && <span className="xs" style={{ color: 'var(--blk-text)' }}>{s.reason.slice(0, 120)}</span>}
                          {isLocked ? (
                            <span className="xs t2">locked</span>
                          ) : (
                            s.status === 'succeeded' && s.storageKey && <LockSheet channelId={channel.id} slug={c.slug} generationId={s.generationId} disabled={screen.canLock ? null : 'The bible is not in the database yet (0048).'} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <GenerateSheet
                channelId={channel.id}
                slug={c.slug}
                name={c.name}
                price={price}
                disabled={screen.sheetInr === null ? `Unpriced: ${screen.sheetNote}` : c.inFlight ? 'A sheet is being drawn — refresh in a minute.' : null}
              />
            </article>
          );
        })}
      </section>
    </main>
  );
}
