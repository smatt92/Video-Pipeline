'use client';

import { useActionState } from 'react';

import { setPublishTargetAction, type AddChannelState } from '@/lib/channels/actions';

const field = 'rounded-sm border px-2 py-1 text-sm';
const fieldStyle = { background: 'var(--s2)', borderColor: 'var(--b2)', color: 'var(--t1)' } as const;

export function TargetForm(props: { channelId: string; platform: 'youtube' | 'instagram'; enabled: boolean; handle: string | null; externalId: string | null }) {
  const [state, action, pending] = useActionState<AddChannelState, FormData>(setPublishTargetAction, { status: 'idle' });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 text-sm">
      <input type="hidden" name="channel_id" value={props.channelId} />
      <input type="hidden" name="platform" value={props.platform} />
      <span className="w-24">{props.platform === 'youtube' ? 'YouTube' : 'Instagram'}</span>
      <label className="flex items-center gap-1"><input type="checkbox" name="enabled" defaultChecked={props.enabled} /> on</label>
      <input name="handle" defaultValue={props.handle ?? ''} placeholder="@handle" className={field} style={fieldStyle} />
      <input name="external_id" defaultValue={props.externalId ?? ''} placeholder={props.platform === 'youtube' ? 'UC… channel id' : 'account id (digits)'} className={field} style={fieldStyle} />
      <button type="submit" disabled={pending} className="btn" >{pending ? 'Saving…' : 'Save'}</button>
      {state.status !== 'idle' && <span style={{ color: state.status === 'ok' ? 'var(--t2)' : 'var(--blk-text)' }}>{state.message}</span>}
    </form>
  );
}
