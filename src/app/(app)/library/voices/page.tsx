import Link from 'next/link';

import { LibraryHeader } from '@/components/library/library-header';
import { TakePlayer } from '@/components/library/take-player';
import { VoiceOverrideForm } from '@/components/library/voice-controls';
import { Bust } from '@/components/ui/bust';
import { Note } from '@/components/ui/card';
import { LockTag } from '@/components/ui/tags';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { TTS_PRESET_IDS, VOICE_PROVIDERS } from '@/lib/drivers/voice-route';
import { voicesScreen, type VoiceRow } from '@/lib/library/voices';
import { storage } from '@/lib/storage';

/**
 * Voices (canvas: Voices, Voices-m) — every character of the active channel, the voice the
 * voice stage will actually use, where that choice came from, and the last take.
 *
 * "Which wins" is not decided here: `voicesScreen` asks `routeForCharacter`, the predicate the
 * voice stage routes with, so this screen and the stage cannot disagree.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Voices' };

async function takeUrl(row: VoiceRow): Promise<string | null> {
  if (!row.take) return null;
  // A presign that fails is "cannot play", shown as such — never a broken player.
  return storage()
    .presignGet({ key: row.take.storageKey, expiresIn: 3600 })
    .then((p) => p.url)
    .catch(() => null);
}

export default async function VoicesPage() {
  const channel = await requireChannel();
  const cb = bibleOrNull(channel);

  if (!cb) {
    return (
      <main className="main">
        <LibraryHeader channel={channel} active="Voices" sub="No cast yet" />
        <div className="empty" style={{ padding: 40 }}>
          <span style={{ color: 'var(--t2)', fontWeight: 500 }}>{channel.name} has no cast yet</span>
          <span>A channel gets its bible and cast when it is created. Add characters in the channel setup, then lock a voice for each.</span>
          <Link className="btn sm pri" href="/channels/new" style={{ marginTop: 8 }}>
            Channel setup
          </Link>
        </div>
      </main>
    );
  }

  const screen = await voicesScreen(serverClient(), channel.id, cb);
  const urls = await Promise.all(screen.rows.map(takeUrl));

  return (
    <main className="main">
      <LibraryHeader
        channel={channel}
        active="Voices"
        sub="One locked preset per character. An override set here wins over the bible’s lock for this channel; clearing it falls back to the bible."
      />

      {screen.tableMissing && <Note>Overrides cannot be read or written: {screen.tableMissing}. Until then every character speaks in the bible’s voice, shown below.</Note>}

      <section className="kgrid ga-300" aria-label="Cast voices">
        {screen.rows.map((r, i) => {
          const url = urls[i];
          return (
            <article className="card card-b col" style={{ gap: 14 }} key={r.slug}>
              <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
                <Bust slug={r.slug} accent={r.accentHex} size="md" />
                <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                  <h2 className="h2">{r.name}</h2>
                  <span className="xs t3">{r.role}</span>
                  {r.route.ok ? (
                    <LockTag>
                      {r.override ? 'override' : 'locked'} · {r.route.voiceId}
                    </LockTag>
                  ) : (
                    <span className="pill s-blk">refused · {r.route.code}</span>
                  )}
                </div>
              </div>
              <p className="sm t2" style={{ minHeight: 40 }}>
                {r.voiceBrief}
              </p>
              {!r.route.ok && <p className="xs" style={{ color: 'var(--blk-text)' }}>{r.route.detail}</p>}
              {!r.take ? (
                <span className="xs t3">No take stored yet — the first episode that voices {r.name} makes one.</span>
              ) : !url ? (
                <span className="xs" style={{ color: 'var(--rev)' }}>
                  A take is stored but could not be presigned.
                </span>
              ) : (
                <div className="col" style={{ gap: 6 }}>
                  <TakePlayer src={url} name={r.name} accent={r.accentHex} label={r.take.createdAt.slice(5, 10)} />
                  <span className="xs" style={{ color: r.take.matchesRoute ? 'var(--t3)' : 'var(--rev)' }}>
                    spoken as {r.take.voiceKey}
                    {r.take.matchesRoute ? '' : ' — not the voice the stage would use now'} · “{r.take.text.slice(0, 80)}”
                  </span>
                </div>
              )}
              <details>
                <summary className="xs t3" style={{ cursor: 'pointer', minHeight: 32, display: 'flex', alignItems: 'center' }}>
                  Bible lock {r.bible.provider}:{r.bible.presetId ?? '— not locked'}
                  {r.override ? ` · override ${r.override.provider}:${r.override.voiceId} since ${r.override.setAt.slice(0, 10)}` : ''} — change
                </summary>
                {!screen.tableMissing && (
                  <div style={{ marginTop: 10 }}>
                    <VoiceOverrideForm slug={r.slug} providers={VOICE_PROVIDERS} presets={TTS_PRESET_IDS} hasOverride={!!r.override} current={r.override} />
                  </div>
                )}
              </details>
            </article>
          );
        })}
      </section>
    </main>
  );
}
