import { TargetForm } from '@/components/channels/target-form';
import { CheckPill, Mono, Panel, Row, SectionHeader } from '@/components/settings/parts';
import { SlotForm, TuningForm, type TuningField } from '@/components/settings/tuning-forms';
import { requireChannel } from '@/lib/channels/active';
import { publishTargets } from '@/lib/channels/list';
import { serverClient } from '@/lib/db/server';
import { readTuning, TUNING_DEFAULTS } from '@/lib/settings/tuning';
import { viewerIsApprover } from '@/lib/settings/viewer';

/**
 * Settings → Publishing, for the active channel. Phase 1 publishes by hand from a bundle
 * (CLAUDE.md): this screen sets what every bundle carries — the slot time and the disclosures
 * — and shows, read-only, what still stands between a bundle and an automatic upload.
 */

export const dynamic = 'force-dynamic';

const DISCLOSURE: TuningField[] = [
  {
    key: 'madeForKids',
    label: 'Made for kids',
    help: 'The value every bundle carries. “Yes” turns off comments and personalised ads on the platform; it is a legal declaration, not a style choice.',
    kind: 'boolean',
    builtIn: TUNING_DEFAULTS.madeForKids,
  },
  {
    key: 'syntheticDisclosure',
    label: 'Altered or synthetic content',
    help: 'When the bundle sets the platform’s altered/synthetic flag. There is deliberately no “never”.',
    kind: 'select',
    options: [
      { value: 'auto', label: 'When a shot is realistic (the platform’s own test)' },
      { value: 'always', label: 'On every video' },
    ],
    builtIn: TUNING_DEFAULTS.syntheticDisclosure,
  },
];

export default async function PublishingSettingsPage() {
  const channel = await requireChannel();
  const db = serverClient();
  const [tuning, canEdit, pol, targets, slots] = await Promise.all([
    readTuning(db, channel.id),
    viewerIsApprover(),
    db.from('channel_policy').select('default_slot_time, slot_timezone, youtube_api_audited, instagram_publish_enabled, daily_publish_cap').eq('channel_id', channel.id).maybeSingle(),
    publishTargets(db, channel.id),
    db.from('v_slot_status').select('id, slot_date, publish_at').eq('channel_id', channel.id).gte('slot_date', new Date().toISOString().slice(0, 10)).order('slot_date').limit(3),
  ]);
  const p = pol.data;
  const zones = (Intl.supportedValuesOf?.('timeZone') ?? []).filter((z) => /^(Asia|Europe|America|Australia|Africa|Pacific)\//.test(z));
  const ig = targets.targets.find((t) => t.platform === 'instagram');

  return (
    <>
      <SectionHeader title="Publishing" hint={`For ${channel.name}. Publishing is manual in this phase: Ready makes the bundle, you schedule it in the platform’s studio.`} />

      <Panel>
        <div className="card-h">
          <h3 className="h3">Slot time</h3>
        </div>
        {!p ? (
          <p className="sm t3">— This channel has no policy row.</p>
        ) : (
          <>
            <p className="xs t3" style={{ marginBottom: 8 }}>
              Every slot publishes at this time on its date. Bundles carry it as the time to schedule; the daily publish cap ({p.daily_publish_cap} a day) counts days in
              this zone.
            </p>
            <SlotForm channelId={channel.id} slotTime={p.default_slot_time} timezone={p.slot_timezone} zones={zones} />
            <div className="xs t3" style={{ marginTop: 8 }}>
              Next slots:{' '}
              {slots.error
                ? `— ${slots.error.message}`
                : (slots.data ?? []).length === 0
                  ? '— none on the calendar ahead'
                  : (slots.data ?? []).map((s) => `${s.slot_date} → ${s.publish_at ? new Date(s.publish_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'}`).join(' · ')}
            </div>
          </>
        )}
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Disclosures every bundle carries</h3>
        </div>
        <TuningForm
          channelId={channel.id}
          fields={DISCLOSURE}
          values={tuning.values}
          disabledReason={tuning.source === 'defaults' ? tuning.reason : null}
          path="/settings/publishing"
          canEdit={canEdit}
        />
        <p className="xs t3" style={{ marginTop: 8 }}>Applies to bundles made after the change. A bundle already on Ready keeps what it was made with.</p>
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Where this channel publishes</h3>
        </div>
        {!targets.fromTable && <p className="xs" style={{ color: 'var(--blk-text)' }}>Publish targets need migration 0046. Until then this channel publishes to its single platform.</p>}
        <div className="col">
          {(['youtube', 'instagram'] as const).map((pl) => {
            const t = targets.targets.find((x) => x.platform === pl);
            return <TargetForm key={pl} channelId={channel.id} platform={pl} enabled={t?.enabled ?? false} handle={t?.handle ?? null} externalId={t?.externalId ?? null} />;
          })}
        </div>
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Automatic upload</h3>
          <span className="xs t3">read-only</span>
        </div>
        <Row label="YouTube upload API" help="channel_policy.youtube_api_audited. False: no upload is attempted; every Short is a bundle you schedule by hand. The audit application was submitted on 07-Oct-2026 and is awaiting Google.">
          <CheckPill passed={p ? (p.youtube_api_audited ? true : null) : null} label={p ? (p.youtube_api_audited ? 'audited' : 'awaiting audit') : '—'} />
        </Row>
        <Row label="Instagram publishing" help="channel_policy.instagram_publish_enabled — off until Meta’s app review clears. The Reels path is being built separately; this screen does not switch it on.">
          <CheckPill passed={p ? (p.instagram_publish_enabled ? true : null) : null} label={p ? (p.instagram_publish_enabled ? 'enabled' : 'off') : '—'} />
          <div className="xs t3" style={{ marginTop: 3 }}>
            Target:{' '}
            {ig ? (
              <>
                {ig.enabled ? 'on' : 'off'} · {ig.handle ?? 'no handle'} · {ig.externalId ? <Mono>{ig.externalId}</Mono> : 'no account id'}
              </>
            ) : (
              '— none set'
            )}
          </div>
        </Row>
      </Panel>
    </>
  );
}
