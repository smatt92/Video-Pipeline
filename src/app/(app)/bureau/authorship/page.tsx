import Link from 'next/link';

import { ScreenHeader } from '@/components/shell/screen-header';
import { requireChannel } from '@/lib/channels/active';
import { serverClient } from '@/lib/db/server';
import { initials } from '@/lib/shell/initials';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Authorship' };

/**
 * Authorship log (canvas: Authorship, Authorship-m) — every decision with its exact text and
 * time, append-only in the database: the channel's evidence of human authorship in an appeal.
 * The third tile is computed, not asserted: publications that reached scheduled/live without
 * a passing review, counted from the rows. The database gate makes it 0; the count is what
 * would show it if that ever stopped being true.
 */

const SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'human', label: 'Human' },
  { key: 'agent', label: 'Agent' },
  { key: 'system', label: 'System' },
] as const;
const HUMAN = new Set(['approver', 'ui']);

export default async function AuthorshipPage({ searchParams }: { searchParams: Promise<{ who?: string }> }) {
  const { who } = await searchParams;
  const scope = SCOPES.some((s) => s.key === who) ? who! : 'all';
  const channel = await requireChannel();
  const db = serverClient();
  const [{ data: rowsRaw }, { data: tokens }, { data: profile }, { data: pubs }] = await Promise.all([
    db
      .from('authorship_log')
      .select('id, occurred_at, actor_scope, token_id, profile_id, action, subject_type, subject_id, exact_text')
      .eq('channel_id', channel.id)
      .order('occurred_at', { ascending: false })
      .limit(200),
    db.from('mcp_tokens').select('id, name'),
    db.from('profiles').select('id, display_name'),
    db.from('publications').select('id, review_id, status').eq('channel_id', channel.id).in('status', ['scheduled', 'uploading', 'live']),
  ]);
  const rows = rowsRaw ?? [];
  const tokenName = new Map((tokens ?? []).map((t) => [t.id, t.name]));
  const personName = new Map((profile ?? []).map((p) => [p.id, p.display_name ?? 'You']));
  const reviewIds = (pubs ?? []).map((p) => p.review_id);
  const { data: reviews } = reviewIds.length ? await db.from('reviews').select('id, decision').in('id', reviewIds) : { data: [] as { id: string; decision: string }[] };
  const passed = new Set((reviews ?? []).filter((r) => r.decision === 'pass').map((r) => r.id));
  const unreviewed = (pubs ?? []).filter((p) => !passed.has(p.review_id)).length;

  const human = rows.filter((r) => HUMAN.has(r.actor_scope));
  const agent = rows.filter((r) => r.actor_scope === 'agent');
  const system = rows.filter((r) => r.actor_scope === 'system');
  const shown = scope === 'human' ? human : scope === 'agent' ? agent : scope === 'system' ? system : rows;
  const humanNames = [...new Set(human.map((r) => (r.profile_id ? personName.get(r.profile_id) : null)).filter(Boolean))];

  return (
    <main className="main">
      <ScreenHeader
        channel={channel}
        crumb="Authorship"
        title="Authorship log"
        mobileTitle="Authorship"
        sub="Every decision, verbatim, with who made it and which token they used. The table refuses edits and deletes."
        actions={SCOPES.map((s) => (
          <Link key={s.key} href={s.key === 'all' ? '/bureau/authorship' : `/bureau/authorship?who=${s.key}`} className={`chip${scope === s.key ? ' on' : ''}`} aria-current={scope === s.key ? 'true' : undefined}>
            {s.label}
            {s.key === 'human' ? ` · ${human.length}` : s.key === 'agent' ? ` · ${agent.length}` : s.key === 'system' ? ` · ${system.length}` : ''}
          </Link>
        ))}
      />

      <section className="kgrid ga-220" aria-label="Summary">
        <div className="card tile">
          <span className="lbl">Human decisions</span>
          <span className="tv">{human.length}</span>
          <span className="why">{humanNames.length ? `approver · ${humanNames.join(', ')}` : 'none logged yet'}</span>
        </div>
        <div className="card tile">
          <span className="lbl">Agent actions</span>
          <span className="tv">{agent.length}</span>
          <span className="why">agent token · drafts, runs, reconciles</span>
        </div>
        <div className="card tile">
          <span className="lbl">Scheduled or live without a passing cut review</span>
          <span className={`tv${unreviewed ? ' tblk' : ''}`}>{unreviewed}</span>
          <span className="why">of {(pubs ?? []).length} scheduled or live · counted from the rows; the database gate refuses the rest</span>
        </div>
      </section>

      <section className="card" aria-label="Log">
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Time · IST</th>
                <th>Who</th>
                <th>Action</th>
                <th>Object</th>
                <th>Exact text</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="sm t3">
                    Nothing logged {scope === 'all' ? 'for this channel yet' : `by ${scope} actors`}.
                  </td>
                </tr>
              )}
              {shown.map((r) => {
                const isHuman = HUMAN.has(r.actor_scope);
                const name = isHuman ? (r.profile_id ? personName.get(r.profile_id) ?? 'Approver' : 'Approver') : r.actor_scope === 'agent' ? (r.token_id ? tokenName.get(r.token_id) ?? 'Agent' : 'Agent') : 'Pipeline';
                const cls = isHuman ? 'h' : r.actor_scope === 'agent' ? 'a' : 's';
                const badge = isHuman ? initials(name) : r.actor_scope === 'agent' ? 'AG' : 'SYS';
                return (
                  <tr key={r.id}>
                    <td className="mono sm">{new Date(r.occurred_at).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>
                      <span className={`who ${cls}`}>
                        <b aria-hidden="true">{badge}</b>
                        {name}
                      </span>
                    </td>
                    <td>{r.action}</td>
                    <td className="mono sm">
                      {r.subject_type} <span className="t3">{r.subject_id.slice(0, 8)}</span>
                    </td>
                    <td className="sm t2">{r.exact_text ?? <span className="t3">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
