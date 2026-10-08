import Link from 'next/link';

import { FallbackDecision, MarkReadOnView } from '@/components/notifications/controls';
import { ScreenHeader } from '@/components/shell/screen-header';
import { Note } from '@/components/ui/card';
import { Orb } from '@/components/glass/orb';
import { type StateTone } from '@/components/ui/tags';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { fallbacksWaiting, listNotifications } from '@/lib/notifications/centre';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Notifications' };

/**
 * Notifications (0053) — every alert Kiln raised for this channel, newest first, and the
 * format fallbacks waiting on the approver at the top.
 *
 * Sahil, 08-Oct: "no notifications received for fallback, no approvals for fallback, no
 * notifications centre". Every alert had been a row since 0037, each one `delivered = false`
 * because no Slack webhook is configured — the rows existed and nothing read them. This screen
 * is what reads them; Slack, when configured, is a copy.
 */

const KIND: Record<string, { tone: StateTone; label: string }> = {
  fallback: { tone: 'rev', label: 'Fallback' },
  qc_failed: { tone: 'blk', label: 'Stopped' },
  kill_switch: { tone: 'blk', label: 'Kill switch' },
  policy_flag: { tone: 'blk', label: 'Policy' },
  cap_80: { tone: 'rev', label: 'Spend cap' },
  cut_ready: { tone: 'ac', label: 'Cut ready' },
  briefs_pending: { tone: 'draft', label: 'Briefs' },
  info: { tone: 'rdy', label: 'Ready' },
};

/** The orb a state lights (Kiln Glass): red for a stop, warm for a decision, calm otherwise. */
const ORB: Record<StateTone, 'alert' | 'warm' | 'calm'> = { blk: 'alert', rev: 'warm', ac: 'warm', draft: 'calm', rdy: 'calm', gen: 'calm', live: 'calm' };

const IST_MS = 5.5 * 3_600_000;
function when(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_MS);
  const today = new Date(Date.now() + IST_MS);
  const day = d.toISOString().slice(0, 10) === today.toISOString().slice(0, 10) ? 'Today' : d.toISOString().slice(5, 10);
  return `${day} ${d.toISOString().slice(11, 16)} IST`;
}

function linkFor(kind: string): { href: string; label: string } | null {
  if (kind === 'cut_ready' || kind === 'fallback') return { href: '/bureau/cuts', label: 'Cuts' };
  if (kind === 'briefs_pending') return { href: '/bureau/approvals', label: 'Approvals' };
  if (kind === 'qc_failed') return { href: '/bureau/board', label: 'Board' };
  if (kind === 'info') return { href: '/bureau/ready', label: 'Ready' };
  if (kind === 'cap_80') return { href: '/bureau/monitor', label: 'Generation' };
  return null;
}

export default async function NotificationsPage() {
  const channel = await requireChannel();
  const db = serverClient();
  const [{ rows, readable }, waiting] = await Promise.all([listNotifications(db, channel.id), fallbacksWaiting(db, channel.id)]);
  const unread = rows.filter((r) => r.readAt === null).length;
  const undelivered = rows.length > 0 && rows.every((r) => !r.delivered);

  return (
    <main className="main">
      <ScreenHeader
        channel={channel}
        crumb="Notifications"
        title="Notifications"
        sub={readable ? (unread ? `${unread} new` : 'Nothing new') : `${rows.length} alerts`}
        mobileTitle="Notifications"
      />
      {readable && <MarkReadOnView channelId={channel.id} unread={unread} />}

      {!readable && <Note>Read and unread need the 0053 bundle in the database. Until it is pasted every alert is listed, with no unread count.</Note>}
      {undelivered && (
        <Note>
          None of these reached Slack: no notification webhook is configured, so this screen is where alerts arrive. Adding one under{' '}
          <Link href="/settings/integrations">Settings → Integrations</Link> sends each one to Slack as well.
        </Note>
      )}

      {waiting.length > 0 && (
        <section className="col" style={{ gap: 10 }} aria-label="Waiting on you">
          <span className="lbl">Waiting on you</span>
          <div className="orbs">
            {waiting.map((w) => (
              <Orb
                key={w.episodeId}
                tone="alert"
                label="Fallback needs approval"
                what={w.reason}
                why={w.premise ?? undefined}
                meta={`episode ${w.episodeId.slice(0, 8)}${w.slotId ? ` · ${w.slotId}` : ''}`}
                actions={<FallbackDecision episodeId={w.episodeId} glass />}
              />
            ))}
          </div>
        </section>
      )}

      <section className="col" style={{ gap: 10 }} aria-label="All alerts">
        {rows.length === 0 ? (
          <div className="card empty" style={{ padding: 32 }}>
            <span className="t2">No alerts yet for {channel.name}.</span>
          </div>
        ) : (
          <div className="orbs">
            {rows.map((r) => {
              const k = KIND[r.kind] ?? { tone: 'draft' as StateTone, label: r.kind };
              const link = linkFor(r.kind);
              const isNew = r.readAt === null;
              return (
                <Orb
                  key={r.id}
                  tone={ORB[k.tone]}
                  read={!isNew}
                  label={`${k.label}${isNew ? ' · new' : ''}`}
                  what={r.text}
                  meta={
                    <>
                      {when(r.createdAt)}
                      {r.episodeId ? ` · ${r.episodeId.slice(0, 8)}` : ''}
                      {r.delivered ? ' · sent to Slack' : ''}
                    </>
                  }
                  actions={
                    link ? (
                      <Link className="gbtn sm" href={link.href}>
                        {link.label}
                      </Link>
                    ) : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
