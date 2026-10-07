'use client';

import { useActionState } from 'react';

import { importCsvAction, type ActionResult } from '@/lib/bureau/ui-actions';

export function CsvImport({ channelId }: { channelId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(importCsvAction, null);
  return (
    <form action={action} className="row" style={{ gap: 10 }}>
      <input type="hidden" name="channel_id" value={channelId} />
      <label className="sr-only" htmlFor="studio-csv">Studio CSV file</label>
      <input id="studio-csv" type="file" name="csv" accept=".csv,text/csv" className="sm" />
      <button disabled={pending} className="btn pri">
        {pending ? 'Importing…' : 'Import Studio CSV'}
      </button>
      {state && <span className="sm" role="status" style={{ color: state.ok ? 'var(--t2)' : 'var(--blk-text)' }}>{state.message}</span>}
    </form>
  );
}
