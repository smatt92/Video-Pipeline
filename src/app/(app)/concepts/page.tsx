import Link from 'next/link';

import { Panel, SectionHeader } from '@/components/settings/parts';
import { requireChannel } from '@/lib/channels/active';
import { listConcepts } from '@/lib/concepts/by-channel';
import { serverClient } from '@/lib/db/server';

/**
 * Concepts for the active channel: each with its latest script, shot count, what it has cost
 * and the episode carrying it. Cost is two figures (settled, estimated) and an em dash when no
 * ledger row exists — never ₹0, and never one sum that would count a charge twice.
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — concepts' };

const inr = (n: number | null) => (n === null ? '—' : `₹${n.toFixed(2)}`);

export default async function ConceptsPage() {
  const channel = await requireChannel();
  const rows = await listConcepts(serverClient(), channel.id);

  return (
    <div className="mx-auto w-full max-w-[1100px] px-6 py-8">
      <SectionHeader title="Concepts" hint={`${channel.name}: the newest 100, with script, shots, spend and episode.`} />
      <Panel>
        {rows.length === 0 ? (
          <p className="px-4 py-4 text-sm" style={{ color: 'var(--t3)' }}>
            No concepts on {channel.name} yet. Stage 2 proposes them from captured trends; a Bureau brief creates one when it is approved and scripted.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr style={{ color: 'var(--t3)' }}>
                {['concept', 'status', 'script', 'shots', 'settled', 'estimated', 'episode'].map((h, i) => (
                  <th key={h} className={`px-4 py-2 font-mono text-3xs font-normal uppercase tracking-[0.08em] ${i === 0 ? 'text-left' : 'text-right'}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t" style={{ borderColor: 'var(--b1)', color: 'var(--t2)' }}>
                  <td className="px-4 py-2 align-top">
                    <Link href={`/concepts/${r.id}`} className="text-sm underline-offset-2 hover:underline" style={{ color: 'var(--t1)' }}>
                      {r.title}
                    </Link>
                    <div className="mt-[2px] max-w-[52ch] truncate" style={{ color: 'var(--t3)' }}>
                      {r.angle}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right align-top font-mono">{r.status}</td>
                  <td className="px-4 py-2 text-right align-top font-mono">{r.script ? `v${r.script.version}` : '—'}</td>
                  <td className="px-4 py-2 text-right align-top font-mono">{r.shotCount === null ? '—' : r.shotCount}</td>
                  <td className="px-4 py-2 text-right align-top font-mono">{inr(r.cost.settledInr)}</td>
                  <td className="px-4 py-2 text-right align-top font-mono">
                    {inr(r.cost.estimatedInr)}
                    {r.cost.unpricedRows > 0 && (
                      <div style={{ color: 'var(--rev)' }}>+ {r.cost.unpricedRows} unpriced</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right align-top font-mono">
                    {r.episode ? (
                      <Link href={r.episode.href} className="underline-offset-2 hover:underline">
                        {r.episode.status}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <p className="mt-3 max-w-[90ch] text-2xs leading-relaxed" style={{ color: 'var(--t3)' }}>
        Settled is what reconciled (and refunds); estimated is what was committed at submit. An estimate and its reconcile are two rows about one
        charge, so the two columns are not added together. Unpriced rows were written with no verified rate and carry no figure.
      </p>
    </div>
  );
}
