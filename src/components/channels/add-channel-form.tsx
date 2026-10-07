'use client';

import { useActionState } from 'react';

import { addChannelAction, type AddChannelState } from '@/lib/channels/actions';

const field = 'w-full rounded-sm border px-2 py-1 text-sm';
const fieldStyle = { background: 'var(--s2)', borderColor: 'var(--b2)', color: 'var(--t1)' } as const;

export function AddChannelForm() {
  const [state, action, pending] = useActionState<AddChannelState, FormData>(addChannelAction, { status: 'idle' });
  return (
    <form action={action} className="mt-4 grid max-w-[560px] gap-3">
      <label className="grid gap-1 text-sm">
        Name
        <input name="name" required className={field} style={fieldStyle} placeholder="Bureau of Reality" />
      </label>
      <label className="grid gap-1 text-sm">
        Slug — lowercase letters, digits and hyphens
        <input name="slug" required className={field} style={fieldStyle} placeholder="my-channel" />
      </label>
      <label className="grid gap-1 text-sm">
        Handle
        <input name="handle" className={field} style={fieldStyle} placeholder="@handle" />
      </label>
      <label className="grid gap-1 text-sm">
        Niche (optional — becomes the bible&apos;s premise)
        <input name="niche" className={field} style={fieldStyle} />
      </label>
      <label className="grid gap-1 text-sm">
        Accent colour (optional — the host&apos;s accent)
        <input name="accent_hex" className={field} style={fieldStyle} placeholder="hex colour, six digits after the hash" />
      </label>
      <fieldset className="grid gap-2 rounded-sm border p-3 text-sm" style={{ borderColor: 'var(--b2)' }}>
        <legend className="px-1 text-2xs" style={{ color: 'var(--t3)' }}>Platform accounts</legend>
        <label className="flex items-center gap-2"><input type="checkbox" name="targets" value="youtube" defaultChecked /> YouTube</label>
        <input name="youtube_channel_id" className={field} style={fieldStyle} placeholder="YouTube channel id (UC…)" />
        <label className="flex items-center gap-2"><input type="checkbox" name="targets" value="instagram" defaultChecked /> Instagram (Reels, manual posting)</label>
        <input name="instagram_account_id" className={field} style={fieldStyle} placeholder="Instagram professional account id (digits)" />
        <input name="instagram_handle" className={field} style={fieldStyle} placeholder="@instagram_handle" />
      </fieldset>
      <button type="submit" disabled={pending} className="btn" >
        {pending ? 'Adding…' : 'Add channel'}
      </button>
      {state.status !== 'idle' && (
        <p className="text-sm" style={{ color: state.status === 'ok' ? 'var(--t2)' : 'var(--blk-text)' }}>{state.message}</p>
      )}
    </form>
  );
}
