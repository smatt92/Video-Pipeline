import { BureauNav } from '@/components/bureau/bureau-nav';
import { BUREAU_CHANNEL_ID, characterBySlug, leadsFromCalendar } from '@/lib/bureau/bible';
import { serverClient } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

/**
 * Calendar — two months of slots, each with its series, lead accent, seasonal tag and where
 * production stands. A slot two days out with no approved brief is flagged: that is the
 * produce-by line, since an episode needs a day to render and a day to review.
 */
export default async function CalendarPage() {
  const db = serverClient();
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0));
  const [{ data: slots }, { count: bank }] = await Promise.all([
    db.from('v_slot_status').select('id, slot_date, series, series_name, lead, topic, seasonal_tag, production_status, kind').eq('channel_id', BUREAU_CHANNEL_ID).gte('slot_date', from.toISOString().slice(0, 10)).lte('slot_date', to.toISOString().slice(0, 10)).order('slot_date'),
    db.from('slots').select('id', { count: 'exact', head: true }).eq('channel_id', BUREAU_CHANNEL_ID).eq('kind', 'bank'),
  ]);
  const byDate = new Map<string, NonNullable<typeof slots>>();
  for (const s of slots ?? []) byDate.set(s.slot_date!, [...(byDate.get(s.slot_date!) ?? []), s]);
  const months = [0, 1].map((m) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + m, 1)));
  const today = now.toISOString().slice(0, 10);
  const produceBy = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-6">
      <BureauNav active="calendar" />
      <h1 className="text-lg font-medium">Calendar</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{bank ?? '—'} bank slots. Flagged: within two days and no approved brief.</p>
      {months.map((m) => {
        const days = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
        const lead = (m.getUTCDay() + 6) % 7;
        return (
          <section key={m.toISOString()} className="mt-6">
            <h2 className="text-sm font-medium">{m.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h2>
            <div className="mt-2 grid grid-cols-7 gap-1 text-2xs">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} style={{ color: 'var(--text-faint)' }}>{d}</div>)}
              {Array.from({ length: lead }, (_, i) => <div key={`pad${i}`} />)}
              {Array.from({ length: days }, (_, i) => {
                const date = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), i + 1)).toISOString().slice(0, 10);
                return (
                  <div key={date} className="min-h-24 rounded border p-1" style={{ borderColor: date === today ? 'var(--border-strong)' : 'var(--border-subtle)' }}>
                    <div className="font-mono" style={{ color: 'var(--text-faint)' }}>{i + 1}</div>
                    {(byDate.get(date) ?? []).map((s) => {
                      const c = characterBySlug(leadsFromCalendar(s.lead)[0] ?? '');
                      const late = date <= produceBy && date >= today && ['open', 'needs_approval'].includes(s.production_status ?? '');
                      return (
                        <div key={s.id} className="mt-1 rounded px-1" style={{ background: 'var(--surface-1)' }} title={s.topic ?? ''}>
                          <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full" style={{ background: c?.accent_hex ?? 'currentColor' }} />
                          <span className="font-mono">{s.id}</span> {s.series_name}
                          {s.seasonal_tag && <span style={{ color: 'var(--text-muted)' }}> · {s.seasonal_tag}</span>}
                          <div style={{ color: late ? 'var(--state-blocked)' : 'var(--text-faint)' }}>{late ? `produce now — ${s.production_status}` : s.production_status}</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}
