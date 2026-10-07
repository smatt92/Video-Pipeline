'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useRef, useState } from 'react';

import {
  confirmBedUploadAction,
  planBedUploadAction,
  setSeriesDefaultAction,
  type LibraryWriteState,
} from '@/lib/library/actions';

import { WriteResult } from './voice-controls';

const IDLE: LibraryWriteState = { status: 'idle' };

const buttonStyle = { borderColor: 'var(--border-default)', color: 'var(--text-secondary)' };

/**
 * Upload one bed: presign (server) → PUT (browser → bucket, rule 2) → confirm (server).
 * The file never touches a Vercel route; only its name, type and size do.
 */
export function BedUpload({ bedId, accept }: { bedId: string; accept: readonly string[] }) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<LibraryWriteState>(IDLE);

  async function upload() {
    const f = file.current?.files?.[0];
    if (!f) {
      setState({ status: 'error', message: 'Choose an audio file first.' });
      return;
    }
    setBusy(true);
    try {
      const meta = { bedId, contentType: f.type, bytes: f.size };
      const plan = await planBedUploadAction(meta);
      if (!plan.ok) {
        setState({ status: 'error', message: plan.message });
        return;
      }
      const put = await fetch(plan.url, { method: 'PUT', body: f, headers: { 'content-type': f.type } });
      if (!put.ok) {
        setState({ status: 'error', message: `The bucket refused the upload: HTTP ${put.status}. Nothing was recorded.` });
        return;
      }
      setState(await confirmBedUploadAction(meta));
      router.refresh();
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={file} type="file" accept={accept.join(',')} className="text-xs" />
        <button type="button" onClick={upload} disabled={busy} className="rounded-sm border px-[8px] py-[4px] text-xs disabled:opacity-60" style={buttonStyle}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      <WriteResult state={state} />
    </div>
  );
}

/** Default bed for one series. Only uploaded beds from that series' pool are offered; the server refuses the rest anyway. */
export function SeriesDefaultForm({ series, choices, current }: { series: string; choices: readonly string[]; current: string | null }) {
  const [state, action] = useActionState(setSeriesDefaultAction, IDLE);
  if (choices.length === 0) {
    return (
      <span className="text-xs" style={{ color: 'var(--text-faint)' }}>
        no bed in this pool is uploaded yet
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <form action={action} className="flex items-center gap-2">
        <input type="hidden" name="series" value={series} />
        <select
          name="bed_id"
          defaultValue={current ?? choices[0]}
          className="rounded-sm border px-2 py-[4px] font-mono text-xs"
          style={{ background: 'var(--surface-inset)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded-sm border px-[8px] py-[4px] text-xs" style={buttonStyle}>
          Set default
        </button>
      </form>
      <WriteResult state={state} />
    </div>
  );
}
