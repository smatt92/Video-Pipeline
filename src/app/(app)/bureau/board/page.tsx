import { BureauNav } from '@/components/bureau/bureau-nav';
import { StartRun } from '@/components/bureau/start-run';
import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

const COLUMNS: { key: string; label: string; statuses: string[] }[] = [
  { key: 'approval', label: 'Needs approval', statuses: [] },
  { key: 'rendering', label: 'Rendering', statuses: ['queued', 'scripting', 'shotlisting', 'estimating', 'voicing', 'generating', 'assembling'] },
  { key: 'qc', label: 'QC', statuses: ['qc'] },
  { key: 'cut', label: 'Needs cut review', statuses: ['awaiting_cut', 'cut_rejected'] },
  { key: 'ready', label: 'Ready', statuses: ['cut_approved', 'bundled'] },
  { key: 'scheduled', label: 'Scheduled', statuses: ['scheduled'] },
  { key: 'live', label: 'Live', statuses: ['live'] },
  { key: 'stopped', label: 'Stopped', statuses: ['halted', 'failed'] },
];

/** Every Bureau episode by state, plus the briefs waiting for a decision. */
export default async function BureauBoardPage() {
  const db = serverClient();
  const [{ data: eps }, { data: pending }] = await Promise.all([
    db.from('episodes').select('id, slot_id, status, status_detail, kind, run_id, updated_at').eq('channel_id', BUREAU_CHANNEL_ID).order('updated_at', { ascending: false }).limit(300),
    db.from('briefs').select('id, slot_id, premise, flagged').eq('channel_id', BUREAU_CHANNEL_ID).eq('status', 'pending').order('created_at'),
  ]);
  return (
    <main className="mx-auto w-full max-w-[1600px] px-4 py-6">
      <BureauNav active="board" />
      <h1 className="text-lg font-medium">Pipeline board</h1>
      <div className="mt-4 grid gap-3 overflow-x-auto md:grid-cols-4 xl:grid-cols-8">
        {COLUMNS.map((c) => {
          const items = c.key === 'approval'
            ? (pending ?? []).map((b) => ({ id: b.id, slot: b.slot_id, line: b.premise, detail: b.flagged ? 'flagged' : null, startable: false, restartable: false }))
            : (eps ?? []).filter((e) => c.statuses.includes(e.status)).map((e) => ({ id: e.id, slot: e.slot_id, line: `${e.kind === 'long_form' ? 'long-form · ' : ''}${e.status}`, detail: e.status_detail, startable: e.status === 'queued' && !e.run_id, restartable: e.status === 'halted' }));
          return (
            <section key={c.key} className="min-w-[180px] rounded-md border p-2" style={{ borderColor: 'var(--border-default)' }}>
              <h2 className="flex justify-between text-sm font-medium">
                {c.label} <span className="font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>{items.length}</span>
              </h2>
              <ul className="mt-2 grid gap-2">
                {items.map((i) => (
                  <li key={i.id} className="rounded px-2 py-1 text-2xs" style={{ background: 'var(--surface-1)' }}>
                    <div className="font-mono">{i.slot ?? 'bank'}</div>
                    <div>{i.line}</div>
                    {i.detail && <div style={{ color: 'var(--state-blocked)' }}>{i.detail}</div>}
                    {i.startable && <StartRun episodeId={i.id} />}
                    {i.restartable && <StartRun episodeId={i.id} restart />}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </main>
  );
}
