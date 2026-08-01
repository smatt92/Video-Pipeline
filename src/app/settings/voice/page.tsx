import { NotSet, Panel, Row, SectionHeader, UnverifiedBanner } from '@/components/settings/parts';
import { Hint } from '@/components/shell/hint';
import { AUDIO_MODEL_POLICY } from '@/lib/drivers/catalog';
import { PRONUNCIATIONS, VOICE_SETTINGS } from '@/lib/fixtures/settings';

/**
 * Voice.
 *
 * The pronunciation table is a real CRUD surface rather than a config constant because
 * it gets an entry roughly weekly — Indian place names, brand names and gaming acronyms
 * are mispronounced by default, and every one is discovered by listening to a take.
 *
 * The alias/phoneme distinction is load-bearing: phoneme tags are honoured by only some
 * models and *silently ignored* by the rest. A rule that does nothing on three of four
 * models is worse than an ugly alias that works everywhere, so the kind is stored rather
 * than inferred.
 */
export default function VoicePage() {
  return (
    <>
      <SectionHeader
        title="Voice"
        hint="Host voice, model per format, and the pronunciation dictionary."
      />
      <UnverifiedBanner what="No voice has been selected and no dictionary entry has been heard back." />

      <Panel className="mb-5">
        <Row
          label="Host voice"
          help="Professional Voice Cloning needs 30 minutes minimum of clean single-speaker audio plus consent verification, and takes days. Start on a library voice."
        >
          {VOICE_SETTINGS.hostVoice ? (
            <span className="text-[12.5px]">{VOICE_SETTINGS.hostVoice}</span>
          ) : (
            <NotSet />
          )}
        </Row>
        <Row
          label="Text normalization"
          help="Off by default on the cheapest model, which reads ₹5,000 as digits."
        >
          <span className="font-mono text-[12.5px]">{VOICE_SETTINGS.normalization}</span>
        </Row>
        <Row
          label="Chunk size"
          help="Language and accent drift on long single generations is documented and repeatable. Chunks are stitched with neighbouring request ids."
        >
          <span className="font-mono text-[12.5px]">{VOICE_SETTINGS.chunkWords} words</span>
        </Row>
      </Panel>

      <SectionHeader title="Model per format" />
      <Panel className="mb-5">
        {AUDIO_MODEL_POLICY.map((m) => (
          <Row key={m.format} label={m.format} help={m.why}>
            <span className="font-mono text-[12px]">{m.model}</span>
          </Row>
        ))}
      </Panel>

      <SectionHeader
        title="Pronunciation dictionary"
        hint={`CMU phonemes — more predictable than IPA. At most ${VOICE_SETTINGS.maxDictionaryLocators} locators may be sent per request, so this table is compiled from, not sent wholesale.`}
      />
      <Panel>
        <div
          className="grid gap-3 border-b px-4 py-2 font-mono text-[10px] uppercase tracking-[0.09em]"
          style={{
            gridTemplateColumns: '132px 78px minmax(0,1fr)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-faint)',
            background: 'var(--surface-inset)',
          }}
        >
          <span>Written</span>
          <span>Kind</span>
          <span>Spoken as</span>
        </div>
        {PRONUNCIATIONS.map((p) => (
          <div
            key={p.grapheme}
            className="grid items-center gap-3 border-b px-4 py-[10px] last:border-b-0"
            style={{ gridTemplateColumns: '132px 78px minmax(0,1fr)', borderColor: 'var(--border-subtle)' }}
          >
            <span className="text-[12.5px]">{p.grapheme}</span>
            <Hint
              content={
                p.kind === 'phoneme'
                  ? 'Honoured by only some models and silently ignored by the rest.'
                  : 'Works on every model.'
              }
            >
              <span
                className="rounded-xs px-[6px] py-[2px] font-mono text-[10.5px]"
                style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
              >
                {p.kind}
              </span>
            </Hint>
            <span className="min-w-0">
              <span className="block truncate font-mono text-[12px]">{p.replacement}</span>
              {p.note && (
                <span className="block truncate text-[10.5px]" style={{ color: 'var(--text-faint)' }}>
                  {p.note}
                </span>
              )}
            </span>
          </div>
        ))}
      </Panel>
    </>
  );
}
