'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { buildInstagramDraftAction, markPostedAction, markScheduledAction, queueDubsAction } from '@/lib/bureau/ui-actions';

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn sm ghost"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

/** Slot time pre-filled in the viewer's local zone; the stored value is an absolute instant. */
export function MarkScheduled({ publicationId, slotTime }: { publicationId: string; slotTime: string | null }) {
  const router = useRouter();
  const local = slotTime ? new Date(new Date(slotTime).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  const [at, setAt] = useState(local);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="field">
        <label htmlFor={`yt-${publicationId}`}>YouTube link</label>
        <input id={`yt-${publicationId}`} className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/shorts/…" />
      </div>
      <div className="field">
        <label htmlFor={`at-${publicationId}`}>Scheduled for</label>
        <input id={`at-${publicationId}`} type="datetime-local" className="input mono" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <button type="button" className="btn pri full" disabled={pending || !at} onClick={() => start(async () => { const r = await markScheduledAction(publicationId, at, url); setMsg(r.message); if (r.ok) router.refresh(); })}>
        {pending ? 'Saving…' : 'Mark scheduled'}
      </button>
      {msg && <p className="sm t2" role="status">{msg}</p>}
      <p className="xs t3">Kiln never uploads or publishes. This only records what you scheduled in YouTube Studio; the link lets metrics find the video.</p>
    </div>
  );
}

export function QueueDubs({ episodeId }: { episodeId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <span>
      <button type="button" disabled={pending} onClick={() => start(async () => setMsg((await queueDubsAction(episodeId, ['hi', 'es', 'pt-BR'])).message))} className="btn sm">
        Queue hi / es / pt-BR dubs
      </button>
      {msg && <span className="xs t3" role="status" style={{ marginLeft: 8 }}>{msg}</span>}
    </span>
  );
}

export function BuildInstagram({ youtubePublicationId }: { youtubePublicationId: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="row" style={{ gap: 8 }}>
      <button type="button" disabled={pending} onClick={() => start(async () => setMsg((await buildInstagramDraftAction(youtubePublicationId)).message))} className="btn sm">
        {pending ? 'Building…' : 'Build Instagram variant'}
      </button>
      {msg && <span className="sm t2" role="status">{msg}</span>}
    </div>
  );
}

export function MarkPosted({ publicationId }: { publicationId: string }) {
  const router = useRouter();
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [at, setAt] = useState(now);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="field">
        <label htmlFor={`ig-${publicationId}`}>Reel permalink</label>
        <input id={`ig-${publicationId}`} className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.instagram.com/reel/…" />
      </div>
      <div className="field">
        <label htmlFor={`igat-${publicationId}`}>Posted at</label>
        <input id={`igat-${publicationId}`} type="datetime-local" className="input mono" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <button type="button" className="btn pri full" disabled={pending || !at || !url} onClick={() => start(async () => { const r = await markPostedAction(publicationId, url, at); setMsg(r.message); if (r.ok) router.refresh(); })}>
        {pending ? 'Saving…' : 'Mark posted'}
      </button>
      {msg && <p className="sm t2" role="status">{msg}</p>}
    </div>
  );
}
