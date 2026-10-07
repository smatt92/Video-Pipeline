import { BedUpload, SeriesDefaultForm } from '@/components/library/music-controls';
import { Panel, SectionHeader } from '@/components/settings/parts';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { MUSIC_CONTENT_TYPES, MUSIC_MAX_BYTES, musicScreen } from '@/lib/library/music';
import { storage } from '@/lib/storage';

/**
 * Music — the beds the active channel's series name, which have audio, and each series'
 * default. Upload goes browser → bucket by presigned PUT (rule 2).
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — music' };

export default async function MusicPage() {
  const channel = await requireChannel();
  const cb = bibleOrNull(channel);

  if (!cb) {
    return (
      <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
        <SectionHeader title="Music" />
        <Panel>
          <p className="px-4 py-4 text-sm" style={{ color: 'var(--text-muted)' }}>
            {channel.name} has no bible folder in this build, so it names no series and no beds.
          </p>
        </Panel>
      </div>
    );
  }

  const screen = await musicScreen(serverClient(), channel.id, cb);
  const urls = await Promise.all(
    screen.beds.map((b) =>
      b.uploaded
        ? storage()
            .presignGet({ key: b.uploaded.storageKey, expiresIn: 3600 })
            .then((p) => p.url)
            .catch(() => null)
        : Promise.resolve(null),
    ),
  );
  const uploaded = new Set(screen.beds.filter((b) => b.uploaded).map((b) => b.bedId));

  return (
    <div className="mx-auto w-full max-w-[1000px] px-6 py-8">
      <SectionHeader title="Music" hint={`${channel.name}: every bed named in a series' music_bed_pool, the audio uploaded for it, and each series' default.`} />

      {/* Said plainly, because an upload screen implies the uploads are used. */}
      <p className="mb-4 rounded-sm border px-3 py-2 text-xs leading-relaxed" style={{ borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}>
        The assembler does not mix a bed yet — the episode render passes no music track. Uploads and defaults are recorded for when it does.
      </p>

      {screen.tableMissing && (
        <p className="mb-4 rounded-sm border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-strong)', color: 'var(--state-review)' }}>
          Beds cannot be recorded: {screen.tableMissing}.
        </p>
      )}

      <Panel className="mb-6">
        <div className="border-b px-4 py-3 text-md font-medium" style={{ borderColor: 'var(--border-subtle)' }}>
          Beds
        </div>
        {screen.beds.map((b, i) => (
          <div key={b.bedId} className="border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-sm">{b.bedId}</span>
              <span className="text-2xs" style={{ color: 'var(--text-faint)' }}>
                {b.series.join(', ')}
              </span>
              <span className="ml-auto font-mono text-2xs" style={{ color: b.uploaded ? 'var(--state-review)' : 'var(--text-faint)' }}>
                {b.uploaded
                  ? `uploaded ${b.uploaded.uploadedAt.slice(0, 10)} · unverified · ${b.uploaded.bytes === null ? '—' : `${(b.uploaded.bytes / 1024 / 1024).toFixed(1)} MB`}`
                  : 'not uploaded'}
              </span>
            </div>
            <div className="mt-2 flex flex-col gap-2">
              {b.uploaded &&
                (urls[i] ? (
                  <audio controls preload="none" src={urls[i]!} className="h-8 w-full max-w-[420px]" />
                ) : (
                  <span className="text-xs" style={{ color: 'var(--state-review)' }}>
                    recorded at {b.uploaded.storageKey} but could not be presigned
                  </span>
                ))}
              {!screen.tableMissing && <BedUpload bedId={b.bedId} accept={Object.keys(MUSIC_CONTENT_TYPES)} />}
            </div>
          </div>
        ))}
        <p className="border-t px-4 py-3 text-2xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-faint)' }}>
          Audio only ({Object.keys(MUSIC_CONTENT_TYPES).join(', ')}), up to {MUSIC_MAX_BYTES / 1024 / 1024} MB. &ldquo;Unverified&rdquo; is on every
          upload: the storage driver cannot check an object exists, so a row means the browser reported the PUT succeeded. Play it to be sure.
        </p>
      </Panel>

      <Panel>
        <div className="border-b px-4 py-3 text-md font-medium" style={{ borderColor: 'var(--border-subtle)' }}>
          Default bed per series
        </div>
        {screen.series.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="w-[160px] text-sm">{s.name}</span>
            <span className="font-mono text-2xs" style={{ color: 'var(--text-faint)' }}>
              {s.defaultBed ?? '—'}
            </span>
            <div className="ml-auto">
              {screen.tableMissing ? (
                <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
                  {screen.tableMissing}
                </span>
              ) : (
                <SeriesDefaultForm series={s.id} choices={s.pool.filter((p) => uploaded.has(p))} current={s.defaultBed} />
              )}
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}
