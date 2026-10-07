import { Mono, Panel, Row, SectionHeader } from '@/components/settings/parts';
import { TuningForm, type TuningField } from '@/components/settings/tuning-forms';
import { SAFE_AREAS } from '@/lib/assemble/composition';
import { requireChannel } from '@/lib/channels/active';
import { CANONICAL } from '@/lib/ingest/normalise';
import { serverClient } from '@/lib/db/server';
import { readTuning, TUNING_DEFAULTS } from '@/lib/settings/tuning';
import { viewerIsApprover } from '@/lib/settings/viewer';

/**
 * Settings → Assembly, for the active channel: the numbers the voice track and the render are
 * built with. Each was a constant until 0049; each is read where the constant was.
 */

export const dynamic = 'force-dynamic';

const W = 1080;
const H = 1920;

const VOICE: TuningField[] = [
  { key: 'lineGapS', label: 'Gap between lines', help: 'Silence the voice track leaves between two lines, so captions do not collide.', kind: 'number', min: 0, max: 2, step: 0.01, unit: 's', builtIn: TUNING_DEFAULTS.lineGapS },
  { key: 'tailS', label: 'Hold after the last word', help: 'So the loop line lands before the Short restarts.', kind: 'number', min: 0, max: 5, step: 0.05, unit: 's', builtIn: TUNING_DEFAULTS.tailS },
];

const RENDER: TuningField[] = [
  { key: 'loudnessLufs', label: 'Loudness target', help: 'The voice is normalised to this before the render; Cuts measures the result against it.', kind: 'number', min: -24, max: -9, step: 0.5, unit: 'LUFS', builtIn: TUNING_DEFAULTS.loudnessLufs },
  { key: 'captionScale', label: 'Caption size', help: 'Caption font size as a fraction of the frame height (0.032 × 1920 = 61 px).', kind: 'number', min: 0.016, max: 0.08, step: 0.001, builtIn: TUNING_DEFAULTS.captionScale },
  { key: 'hookScale', label: 'Hook title size', help: 'The opening title’s font size, as a fraction of the frame height.', kind: 'number', min: 0.02, max: 0.12, step: 0.001, builtIn: TUNING_DEFAULTS.hookScale },
  { key: 'hookS', label: 'Hook duration', help: 'How long the opening title holds. 0 shows no title.', kind: 'number', min: 0, max: 6, step: 0.1, unit: 's', builtIn: TUNING_DEFAULTS.hookS },
];

export default async function AssemblySettingsPage() {
  const channel = await requireChannel();
  const db = serverClient();
  const [tuning, canEdit] = await Promise.all([readTuning(db, channel.id), viewerIsApprover()]);
  const disabled = tuning.source === 'defaults' ? tuning.reason : null;
  const safe = SAFE_AREAS.shorts_9x16;
  const box = { x: Math.round(W * safe.left), y: Math.round(H * safe.top), w: Math.round(W * (1 - safe.left - safe.right)), h: Math.round(H * (1 - safe.top - safe.bottom)) };
  const v = tuning.values;

  return (
    <>
      <SectionHeader title="Assembly" hint={`For ${channel.name}. A change affects the next render only — a cut already made is not re-rendered.`} />

      <Panel>
        <div className="card-h">
          <h3 className="h3">Voice track</h3>
        </div>
        <TuningForm channelId={channel.id} fields={VOICE} values={tuning.values} disabledReason={disabled} path="/settings/assembly" canEdit={canEdit} />
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Render</h3>
        </div>
        <TuningForm channelId={channel.id} fields={RENDER} values={tuning.values} disabledReason={disabled} path="/settings/assembly" canEdit={canEdit} />
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Safe area · Shorts 9:16</h3>
          <span className="xs t3">read-only</span>
        </div>
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <svg viewBox={`0 0 ${W} ${H}`} width={135} height={240} role="img" aria-label="Where captions and the hook may be drawn inside a 1080 by 1920 frame" style={{ flex: 'none', border: '1px solid var(--b2)', borderRadius: 8, background: 'var(--in)' }}>
            <rect x={box.x} y={box.y} width={box.w} height={box.h} fill="none" stroke="var(--t2)" strokeWidth={10} strokeDasharray="30 18" />
            <rect x={box.x + 20} y={box.y + box.h - Math.round(H * v.captionScale * 2.6)} width={box.w - 40} height={Math.round(H * v.captionScale * 1.3)} rx={12} fill="var(--t3)" opacity={0.5} />
            <rect x={box.x + 20} y={box.y + 30} width={box.w - 40} height={Math.round(H * v.hookScale * 1.2)} rx={12} fill="var(--t2)" opacity={0.5} />
          </svg>
          <div className="col" style={{ gap: 4, minWidth: 0, flex: '1 1 260px' }}>
            <p className="sm">
              Text stays inside <Mono>{box.w}×{box.h}</Mono> at <Mono>({box.x}, {box.y})</Mono> of the 1080×1920 frame: {Math.round(safe.top * 100)}% top, {Math.round(safe.bottom * 100)}% bottom,{' '}
              {Math.round(safe.left * 100)}% left, {Math.round(safe.right * 100)}% right are kept clear.
            </p>
            <p className="xs t3">{safe.note}</p>
            <p className="xs t3">
              {safe.verified ? 'Checked on a real post.' : 'Not yet checked against a real post on a handset — these insets are from the platform’s published layout.'} Set in code
              (<Mono>src/lib/assemble/composition.ts</Mono>), not here: a wrong inset puts captions under the platform’s buttons on every video.
            </p>
            <p className="xs t3">
              At the current sizes: captions {Math.round(H * v.captionScale)} px, hook {Math.round(H * v.hookScale)} px, held {v.hookS} s.
            </p>
          </div>
        </div>
      </Panel>

      <Panel>
        <Row label="Canonical codec" help="Every clip is normalised to one intermediate before assembly; the encoder settings live with the ingest stage.">
          <span className="mono sm">
            {CANONICAL.vcodec} · {CANONICAL.width}×{CANONICAL.height} · {CANONICAL.fps} fps · {CANONICAL.pixFmt}
          </span>
        </Row>
      </Panel>
    </>
  );
}
