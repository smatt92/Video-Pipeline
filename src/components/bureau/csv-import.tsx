'use client';

import { useActionState } from 'react';

import { importCsvAction, type ActionResult } from '@/lib/bureau/ui-actions';

export function CsvImport({ channelId }: { channelId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(importCsvAction, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="channel_id" value={channelId} />
      <input type="file" name="csv" accept=".csv,text/csv" className="text-sm" />
      <button disabled={pending} className="min-h-11 rounded-md px-3 text-sm font-medium" style={{ background: 'var(--accent)', color: 'var(--accent-contrast)' }}>
        {pending ? 'Importing…' : 'Import Studio CSV'}
      </button>
      {state && <span className="text-sm" style={{ color: state.ok ? 'var(--text-secondary)' : 'var(--danger)' }}>{state.message}</span>}
    </form>
  );
}
