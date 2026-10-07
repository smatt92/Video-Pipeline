import Link from 'next/link';

import { CheckPill, Mono, Panel, Row, SectionHeader } from '@/components/settings/parts';
import { SeriesDefaultsRow, StillStyleForm, TuningForm, type TuningField } from '@/components/settings/tuning-forms';
import { getBible } from '@/lib/bureau/bible';
import { FORMAT_INFO, formatOf, PACE_INFO, paceOf, VISUAL_FORMATS, VOICE_PACES, type VoicePace } from '@/lib/bureau/formats';
import { stillStyle } from '@/lib/bureau/stills';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { stillPromptPreview, STILL_STYLE_MAX } from '@/lib/settings/admin';
import { generationStatus } from '@/lib/settings/generation-status';
import { readTuning, TUNING_DEFAULTS } from '@/lib/settings/tuning';
import { viewerIsApprover } from '@/lib/settings/viewer';

/**
 * Settings → Generation, for the active channel: how pictures are made and what is switched
 * on. Every number comes from the rows; what cannot be changed here says where it is changed.
 */

export const dynamic = 'force-dynamic';

const PICTURE_FIELDS: TuningField[] = [
  {
    key: 'secondsPerPicture',
    label: 'Seconds per picture',
    help: 'An illustrated shot gets a new picture about this often. The estimate, the stills step and the assembler all read this one value.',
    kind: 'number',
    min: 2,
    max: 30,
    step: 0.5,
    unit: 's',
    builtIn: TUNING_DEFAULTS.secondsPerPicture,
  },
  {
    key: 'maxPicturesPerShot',
    label: 'Most pictures per shot',
    help: 'However long a shot runs, it never gets more than this many pictures (each one is billed).',
    kind: 'number',
    min: 1,
    max: 12,
    step: 1,
    builtIn: TUNING_DEFAULTS.maxPicturesPerShot,
  },
];

export default async function GenerationSettingsPage() {
  const channel = await requireChannel();
  const db = serverClient();
  const [tuning, cb, status, canEdit, policy] = await Promise.all([
    readTuning(db, channel.id),
    getBible(db, channel.id),
    generationStatus(db, channel.id),
    viewerIsApprover(),
    db.from('channel_policy').select('stills_enabled').eq('channel_id', channel.id).maybeSingle(),
  ]);
  const stillsEnabled = policy.error ? null : (policy.data?.stills_enabled ?? null);
  const series = Object.values(cb.series).filter((s): s is NonNullable<typeof s> => !!s);
  const lead = cb.bible.characters[0];
  const accent = lead?.accent_hex ?? cb.bible.world.palette.chalk;
  const formats = VISUAL_FORMATS.map((f) => ({ value: f, label: FORMAT_INFO[f].label }));
  const paces = (Object.keys(VOICE_PACES) as VoicePace[]).map((p) => ({ value: p, label: `${PACE_INFO[p].label} (${VOICE_PACES[p]}×)` }));

  return (
    <>
      <SectionHeader title="Generation" hint={`For ${channel.name}. Changes apply to the next episode planned or drawn; nothing already made changes.`} />

      <Panel>
        <div className="card-h">
          <h3 className="h3">Scene pictures</h3>
          <CheckPill passed={status.stills.available ? true : stillsEnabled === false ? null : false} label={status.stills.available ? 'available' : 'unavailable'} />
        </div>
        <Row label="Pictures on this channel" help="The per-channel switch (channel_policy.stills_enabled). Off → every shot is drawn as a chalk diagram, and the episode records why.">
          <span className="mono sm">{stillsEnabled === null ? '— (needs migration 0047)' : stillsEnabled ? 'on' : 'off'}</span>
          <div className="xs t3" style={{ marginTop: 3 }}>
            Switched on the setup Caps page. {status.stills.reason ? `Right now: ${status.stills.reason}.` : 'Right now every check passes.'}
          </div>
        </Row>
        <TuningForm channelId={channel.id} fields={PICTURE_FIELDS} values={tuning.values} disabledReason={tuning.source === 'defaults' ? tuning.reason : null} path="/settings/generation" canEdit={canEdit} />
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Per-series defaults</h3>
        </div>
        <p className="xs t3" style={{ marginBottom: 8 }}>
          The video type and voice pace every new episode of a series starts with. Approvals can still pick another for one episode before anything is spent.
          {cb.source !== 'db' && ' This channel’s bible is still the folder in the build, so these are read-only until the 0048 bundle (with the Bureau import) is pasted.'}
        </p>
        {series.length === 0 ? (
          <p className="sm t3">This channel runs no series yet.</p>
        ) : (
          series.map((s) => {
            const f = formatOf({ seriesFormat: s.visual_format });
            const p = paceOf({ seriesPace: s.voice_pace });
            return (
              <Row
                key={s.id}
                label={s.name}
                help={`Now: ${FORMAT_INFO[f.format].label}${f.source === 'default' ? ' (built-in default)' : ''} · ${PACE_INFO[p.pace].label}${p.source === 'default' ? ' (built-in default)' : ''}.`}
              >
                <SeriesDefaultsRow channelId={channel.id} seriesId={s.id} format={f.format} pace={p.pace} formats={formats} paces={paces} editable={canEdit && cb.source === 'db'} />
              </Row>
            );
          })
        )}
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Picture style</h3>
        </div>
        <p className="xs t3" style={{ marginBottom: 8 }}>
          One sentence describing the look of every generated picture (the bible’s <Mono>world.still_style</Mono>). Code appends the highlight colour and the
          “no people” clause after it, so no style can put the cast on screen.
          {!cb.bible.world.still_style && ' Not set: pictures use a sentence built from the palette, shown below.'}
        </p>
        <StillStyleForm channelId={channel.id} current={cb.bible.world.still_style ?? stillStyle(cb.bible.world)} max={STILL_STYLE_MAX} editable={canEdit && cb.source === 'db'} />
        <div className="field" style={{ marginTop: 12 }}>
          <label>The prompt a picture is sent with — a sample scene, {lead ? `${lead.name}’s accent` : 'the chalk colour'} (read-only)</label>
          <p className="mono xs t2" style={{ whiteSpace: 'pre-wrap', background: 'var(--in)', border: '1px solid var(--b1)', borderRadius: 9, padding: '10px 12px' }}>
            {stillPromptPreview(cb.bible.world, accent)}
          </p>
        </div>
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">What generates, right now</h3>
          <span className="xs t3">read-only</span>
        </div>
        <Row label="Active recipes" help="Rows in the prompt library marked active — what a generated video shot can be made with. Changed on Library → Prompts.">
          {status.recipes.length === 0 ? (
            <span className="sm t3">None active — no shot can be generated as video; shots are pictures or diagrams.</span>
          ) : (
            <ul className="col" style={{ gap: 2 }}>
              {status.recipes.map((r) => (
                <li key={`${r.name}-${r.version}`} className="xs">
                  <span className="mono">{r.name}</span> v{r.version} · <Mono>{r.driver}/{r.model}</Mono>
                  {r.acceptsCharacterRef ? ' · takes a character reference' : ''}
                </li>
              ))}
            </ul>
          )}
          <div className="xs" style={{ marginTop: 4 }}>
            <Link href="/library/prompts" style={{ color: 'var(--ac)' }}>Library → Prompts</Link>
          </div>
        </Row>
        <Row label="Failover generation" help="GENERATION_FAILOVER in the environment. Off: every generated shot goes to the primary video integration; the dormant ones stay configured but unused.">
          <span className="mono sm">{status.failover === null ? `— ${status.failoverProblem}` : status.failover ? 'on' : 'off'}</span>
        </Row>
        <Row label="Picture integration" help="The integration scene pictures are made with. A picture is never requested until its Save and test has passed.">
          <CheckPill passed={status.stillIntegration.usable} label={status.stillIntegration.usable ? 'verified' : 'not usable'} />
          {!status.stillIntegration.usable && <div className="xs t3" style={{ marginTop: 3 }}>{status.stillIntegration.reason}</div>}
          <div className="xs" style={{ marginTop: 4 }}>
            <Link href={`/settings/integrations#integration-${status.stillIntegration.slug}`} style={{ color: 'var(--ac)' }}>Integrations → Save and test</Link>
          </div>
        </Row>
        <Row label="Picture rate" help="From the rate card, per image. The estimate on Approvals multiplies this by the pictures each shot gets.">
          {status.stillRate ? (
            <span className="mono sm">
              ${status.stillRate.usd.toFixed(4)} per image{status.stillRate.verified ? '' : ' (unverified)'} · since {status.stillRate.effectiveFrom.slice(0, 10)}
            </span>
          ) : (
            <span className="mono sm t3">— {status.stillRateDetail}</span>
          )}
        </Row>
        <p className="xs t3" style={{ marginTop: 8 }}>
          The optional integrations (the failover video vendors and the direct voice upgrade) stay configured on Integrations; nothing here removes them.
        </p>
      </Panel>
    </>
  );
}
