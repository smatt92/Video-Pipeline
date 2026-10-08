import Link from 'next/link';

import { FallbackDecision, MarkReadOnView } from '@/components/notifications/controls';
import { ScreenHeader } from '@/components/shell/screen-header';
import { Note } from '@/components/ui/card';
import { Pill, type StateTone } from '@/components/ui/tags';
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
          {waiting.map((w) => (
            <article className="card card-b col" key={w.episodeId} style={{ gap: 8, borderColor: 'var(--rev)', background: 'var(--rev-wash)' }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Pill tone="rev">Fallback needs approval</Pill>
                <span className="mono xs t3">episode {w.episodeId.slice(0, 8)}{w.slotId ? ` · ${w.slotId}` : ''}</span>
              </div>
              {w.premise && <span className="sm" style={{ fontWeight: 500 }}>{w.premise}</span>}
              <span className="sm t2">{w.reason}</span>
              <FallbackDecision episodeId={w.episodeId} />
            </article>
          ))}
        </section>
      )}

      <section className="card col" style={{ gap: 0, padding: 0, overflow: 'hidden' }} aria-label="All alerts">
        {rows.length === 0 ? (
          <div className="empty" style={{ padding: 32 }}>
            <span className="t2">No alerts yet for {channel.name}.</span>
          </div>
        ) : (
          rows.map((r, i) => {
            const k = KIND[r.kind] ?? { tone: 'draft' as StateTone, label: r.kind };
            const link = linkFor(r.kind);
            const isNew = r.readAt === null;
            return (
              <div
                key={r.id}
                className="row"
                style={{
                  gap: 12,
                  padding: '12px 16px',
                  alignItems: 'flex-start',
                  flexWrap: 'nowrap',
                  borderTop: i === 0 ? 'none' : '1px solid var(--b1)',
                  background: isNew ? 'var(--s2)' : undefined,
                }}
              >
                <div style={{ flex: 'none', width: 104 }}>
                  <Pill tone={k.tone}>{k.label}</Pill>
                </div>
                <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                  <span className="sm" style={{ overflowWrap: 'anywhere', fontWeight: isNew ? 500 : 400 }}>
                    {r.text}
                  </span>
                  <span className="xs t3">
                    {when(r.createdAt)}
                    {r.episodeId ? <> · <span className="mono">{r.episodeId.slice(0, 8)}</span></> : null}
                    {r.delivered ? ' · sent to Slack' : ''}
                    {link ? (
                      <>
                        {' · '}
                        <Link href={link.href}>{link.label}</Link>
                      </>
                    ) : null}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </section>
    </main>
  );
}
