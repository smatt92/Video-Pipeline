import { VoiceOverrideForm } from '@/components/library/voice-controls';
import { Panel, SectionHeader } from '@/components/settings/parts';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { TTS_PRESET_IDS, VOICE_PROVIDERS } from '@/lib/drivers/voice-route';
import { voicesScreen, type VoiceRow } from '@/lib/library/voices';
import { storage } from '@/lib/storage';

/**
 * Voices — every character of the active channel, the voice the voice stage will actually use,
 * and where that choice came from.
 *
 * "Which wins" is not decided here: `voicesScreen` asks `routeForCharacter`, the predicate the
 * voice stage routes with, so this screen and the stage cannot disagree.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — voices' };

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
      <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
        <SectionHeader title="Voices" />
        <Panel>
          <p className="px-4 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
            {channel.name} has no bible folder in this build, so it has no cast to voice. Create one with{' '}
            <code className="font-mono">pnpm channel:new {channel.slug ?? '<slug>'}</code>, commit and deploy.
          </p>
        </Panel>
      </div>
    );
  }

  const screen = await voicesScreen(serverClient(), channel.id, cb);
  const urls = await Promise.all(screen.rows.map(takeUrl));

  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
      <SectionHeader
        title="Voices"
        hint={`${channel.name}: the voice each character speaks in. An override set here wins over the bible's lock for this channel; clearing it falls back to the bible.`}
      />

      {screen.tableMissing && (
        <p className="mb-4 rounded-sm border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-strong)', color: 'var(--state-review)' }}>
          Overrides cannot be read or written: {screen.tableMissing}. Until then every character speaks in the bible&rsquo;s voice, shown below.
        </p>
      )}

      <Panel>
        {screen.rows.map((r, i) => {
          const url = urls[i];
          return (
            <div key={r.slug} className="border-b px-4 py-4 last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex flex-wrap items-baseline gap-3">
                <span aria-hidden className="inline-block size-[10px] shrink-0 rounded-full" style={{ background: r.accentHex }} />
                <span className="text-md font-medium">{r.name}</span>
                <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  {r.role}
                </span>
                <span className="ml-auto font-mono text-2xs" style={{ color: r.route.ok ? 'var(--state-live)' : 'var(--state-blocked)' }}>
                  {r.route.ok ? `speaks as ${r.route.provider}:${r.route.voiceId} · from the ${r.source}` : `refused · ${r.route.code}`}
                </span>
              </div>

              <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[140px_1fr]">
                <dt style={{ color: 'var(--text-faint)' }}>bible lock</dt>
                <dd className="font-mono">
                  {r.bible.provider}:{r.bible.presetId ?? '— not locked'}
                </dd>
                <dt style={{ color: 'var(--text-faint)' }}>override</dt>
                <dd className="font-mono">
                  {r.override ? (
                    <>
                      {r.override.provider}:{r.override.voiceId}
                      <span style={{ color: 'var(--text-faint)' }}>
                        {' '}
                        · set {r.override.setAt.slice(0, 10)}
                        {r.override.note ? ` · ${r.override.note}` : ''}
                      </span>
                    </>
                  ) : (
                    '—'
                  )}
                </dd>
                {!r.route.ok && (
                  <>
                    <dt style={{ color: 'var(--text-faint)' }}>why refused</dt>
                    <dd style={{ color: 'var(--state-blocked)' }}>{r.route.detail}</dd>
                  </>
                )}
                <dt style={{ color: 'var(--text-faint)' }}>voice brief</dt>
                <dd style={{ color: 'var(--text-secondary)' }}>{r.voiceBrief}</dd>
                <dt style={{ color: 'var(--text-faint)' }}>last take</dt>
                <dd>
                  {!r.take ? (
                    <span style={{ color: 'var(--text-faint)' }}>no take stored yet</span>
                  ) : !url ? (
                    <span style={{ color: 'var(--state-review)' }}>a take is stored ({r.take.storageKey}) but could not be presigned</span>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <audio controls preload="none" src={url} className="h-8 w-full max-w-[420px]" />
                      <span className="text-2xs" style={{ color: r.take.matchesRoute ? 'var(--text-faint)' : 'var(--state-review)' }}>
                        {r.take.createdAt.slice(0, 10)} · spoken as {r.take.voiceKey}
                        {r.take.matchesRoute ? '' : ' — not the voice the stage would use now'} · &ldquo;{r.take.text.slice(0, 80)}&rdquo;
                      </span>
                    </div>
                  )}
                </dd>
              </dl>

              {!screen.tableMissing && (
                <div className="mt-3">
                  <VoiceOverrideForm
                    slug={r.slug}
                    providers={VOICE_PROVIDERS}
                    presets={TTS_PRESET_IDS}
                    hasOverride={!!r.override}
                    current={r.override}
                  />
                </div>
              )}
            </div>
          );
        })}
      </Panel>
    </div>
  );
}
