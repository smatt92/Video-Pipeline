import { KillSwitch } from '@/components/glass/kill-switch';

/**
 * Kill switch card (canvas: Generation). On = stopped: no new generation claims, no
 * publishing. The control is the same physical switch as the top bar's (glass/kill-switch):
 * turning it on asks for a reason (logged verbatim), turning it off asks to confirm, and the
 * server action checks the approver.
 */
export function KillSwitchCard({
  channelId,
  channelName,
  on,
  reason,
  known,
}: {
  channelId: string;
  channelName: string;
  on: boolean;
  reason: string | null;
  known: boolean;
}) {
  return (
    <section className="side card" style={{ borderColor: 'var(--blk-line)' }} aria-label="Kill switch">
      <div className="card-h">
        <h2 className="h3">Kill switch</h2>
        <KillSwitch kill={known ? { on, reason } : null} channelId={channelId} showLabel={false} />
      </div>
      <div className="card-b col" style={{ gap: 10 }}>
        <span className="sm t2">{!known ? 'No policy row for this channel — nothing to switch.' : on ? `On — ${reason ?? 'stopped'}` : 'Off · pipeline running'}</span>
        <p className="xs t3">Halts every queued and in-flight job for {channelName}, and stops spend. Asks to confirm. Approver only.</p>
      </div>
    </section>
  );
}
