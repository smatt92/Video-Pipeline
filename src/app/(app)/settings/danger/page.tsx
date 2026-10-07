import Link from 'next/link';

import { OrphanFinder, UnstickEpisode } from '@/components/settings/danger-zone';
import { CheckPill, Panel, SectionHeader } from '@/components/settings/parts';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { allIntegrationViews } from '@/lib/onboarding/step-view';
import { confirmPhrase, stuckEpisodes } from '@/lib/settings/admin';
import { viewerIsApprover } from '@/lib/settings/viewer';

/**
 * Settings → Danger zone. Approver only. Three things, each recoverable or checked twice:
 * delete orphaned files (on the worker, after a dry run and two confirmations), halt a stuck
 * episode so Restart appears (nothing deleted), and a key-rotation checklist (no secret shown).
 *
 * Deliberately absent: resetting the rate card, any way past the publish gate
 * (enforce_review_pass), and deleting an episode.
 */

export const dynamic = 'force-dynamic';

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 120 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

export default async function DangerZonePage() {
  const channel = await requireChannel();
  if (!(await viewerIsApprover())) {
    return (
      <>
        <SectionHeader title="Danger zone" />
        <p className="sm t3">Only the approver can open this section.</p>
      </>
    );
  }
  const db = serverClient();
  const [phrase, stuck, views] = await Promise.all([confirmPhrase(db, channel.id), stuckEpisodes(db, channel.id), allIntegrationViews()]);
  const confirm = phrase ?? channel.id;

  return (
    <>
      <SectionHeader
        title="Danger zone"
        hint={`For ${channel.name}. Every action here asks you to type ${confirm} and is written to Authorship. There is no reset for the rate card, no way past the publish gate, and no way to delete an episode.`}
      />

      <Panel>
        <div className="card-h">
          <h3 className="h3">Orphaned files</h3>
        </div>
        <p className="xs t3" style={{ marginBottom: 8 }}>
          Stored files no render, voice take, generation, picture, dub or bundle points at, and older than 48 hours. The list is a dry run. Deleting runs on the worker
          — never through this page — and the worker checks each file again first, so one that gained a reference since you looked is kept. Assets are
          workspace-wide: this covers every channel.
        </p>
        <OrphanFinder channelId={channel.id} phrase={confirm} />
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Unstick an episode</h3>
        </div>
        <p className="xs t3" style={{ marginBottom: 8 }}>
          For a failed episode, or one that has written nothing for 30 minutes (the worker ended without saying so). It is set to halted with your reason, so
          Restart run appears on the Board. Nothing is deleted; a restart re-uses what was already paid for.
        </p>
        <UnstickEpisode
          channelId={channel.id}
          phrase={confirm}
          episodes={stuck.map((e) => ({ id: e.id, label: `${e.slot_id ?? 'bank'} · ${e.status} · last wrote ${ago(e.updated_at)}${e.status_detail ? ` · ${e.status_detail.slice(0, 80)}` : ''}` }))}
        />
      </Panel>

      <Panel>
        <div className="card-h">
          <h3 className="h3">Rotate keys</h3>
        </div>
        <p className="xs t3" style={{ marginBottom: 8 }}>
          A checklist, not a button: for each integration, make a new key at the vendor, paste it into its card on Integrations and press Save and test, then revoke
          the old one at the vendor. No key is shown here. A key that lives in the environment is changed in Vercel, then the worker is redeployed so it gets the
          new value.
        </p>
        <table className="tbl">
          <thead>
            <tr>
              <th>Integration</th>
              <th>Last verified</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {views.map((v) => (
              <tr key={v.slug}>
                <td>{v.label}</td>
                <td>
                  {v.lastVerifiedAt ? (
                    <span className="mono xs">{v.lastVerifiedAt.slice(0, 10)}</span>
                  ) : (
                    <CheckPill passed={null} label="never verified" />
                  )}
                </td>
                <td>
                  <Link href={`/settings/integrations#integration-${v.slug}`} style={{ color: 'var(--ac)' }} className="xs">
                    Save and test →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
