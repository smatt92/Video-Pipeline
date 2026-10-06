import { BureauNav } from '@/components/bureau/bureau-nav';
import { BUREAU_CHANNEL_ID } from '@/lib/bureau/bible';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/**
 * Authorship log — every decision with its exact text and time, append-only in the database.
 * The channel's evidence of human authorship in an appeal.
 */
export default async function AuthorshipPage() {
  const db = serverClient();
  const [{ data: rows }, { data: tokens }] = await Promise.all([
    db.from('authorship_log').select('id, occurred_at, actor_scope, token_id, action, subject_type, subject_id, exact_text').eq('channel_id', BUREAU_CHANNEL_ID).order('occurred_at', { ascending: false }).limit(200),
    db.from('mcp_tokens').select('id, name'),
  ]);
  const name = new Map((tokens ?? []).map((t) => [t.id, t.name]));
  return (
    <main className="mx-auto w-full max-w-[1100px] px-4 py-6">
      <BureauNav active="authorship" />
      <h1 className="text-lg font-medium">Authorship log</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Latest 200. The table refuses edits and deletes.</p>
      <table className="mt-4 w-full text-sm">
        <thead className="text-left text-2xs" style={{ color: 'var(--text-muted)' }}>
          <tr><th className="py-1">When (IST)</th><th>Who</th><th>Action</th><th>Subject</th><th>Exact text</th></tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id} className="align-top">
              <td className="py-1 font-mono text-2xs">{new Date(r.occurred_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
              <td className="text-2xs">{r.actor_scope}{r.token_id ? ` · ${name.get(r.token_id) ?? 'token'}` : ''}</td>
              <td className="text-2xs">{r.action}</td>
              <td className="font-mono text-2xs">{r.subject_type} {r.subject_id.slice(0, 8)}</td>
              <td>{r.exact_text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
