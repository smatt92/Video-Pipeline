import { ApprovalCard, type ApprovalBrief } from '@/components/bureau/approval-card';
import { BureauNav } from '@/components/bureau/bureau-nav';
import { bibleOrNull, requireChannel } from '@/lib/channels/active';
import { pendingBriefs } from '@/lib/bureau/briefs';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/**
 * Approvals — the fastest screen in the product, built for a phone. Every pending brief, in
 * slot order: premise (editable), the three punchlines as tap targets, "write my own", the
 * fact and its source, the estimate (or "unpriced"), and the server's own check results.
 * Approving here and approving in Claude chat call the same function and log the same way.
 */
export default async function ApprovalsPage() {
  const channel = await requireChannel();
  const cb = bibleOrNull(channel);
  const briefs = await pendingBriefs(serverClient(), channel.id);
  const cards: ApprovalBrief[] = briefs.map((b) => {
    const lead = cb?.characterBySlug(b.lead_character);
    return {
      id: b.id,
      n: b.n,
      slotId: b.slot_id,
      slotDate: b.slot_date,
      series: b.series,
      lead: b.lead_character,
      leadName: lead?.name ?? b.lead_character,
      leadAccent: lead?.accent_hex ?? 'currentColor',
      premise: b.premise,
      punchlines: (Array.isArray(b.punchlines) ? b.punchlines : []).map(String),
      fact: b.fact as { claim: string; source_url: string },
      estimateInr: b.estimate_inr === null ? null : Number(b.estimate_inr),
      flagged: b.flagged,
      flagReasons: b.flag_reasons ?? [],
      variation: String((b.variation as { status?: string } | null)?.status ?? '—'),
      policy: String((b.policy as { status?: string } | null)?.status ?? '—'),
    };
  });
  return (
    <main className="mx-auto w-full max-w-[720px] px-4 py-6">
      <BureauNav active="approvals" />
      <h1 className="text-lg font-medium">Approvals</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
        {cards.length === 0 ? 'Nothing waiting.' : `${cards.length} brief${cards.length === 1 ? '' : 's'} waiting.`} Keys on a focused card: A/B/C pick, F write your own, Enter approve, K reject.
      </p>
      <div className="mt-4 grid gap-4">
        {cards.map((c, i) => (
          <ApprovalCard key={c.id} brief={c} autoFocus={i === 0} />
        ))}
      </div>
    </main>
  );
}
