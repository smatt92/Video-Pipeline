import 'server-only';

import type { ChannelBible } from '../bureau/bible';
import type { Db } from '../db/server';

/**
 * Reads shared by the redesigned screens. Each function is a flat query (no embedded selects —
 * the harness shim cannot do them, and a screen should not be the first to need it) and maps
 * numerics at this boundary: `estimate_inr` arrives as a string and leaves as `number | null`.
 */

export interface CastRef {
  slug: string;
  name: string;
  accent: string | undefined;
  lead: boolean;
}

/** Calendar leads ("pip+marlo") and a brief's lead + supporting cast → chips, lead first. */
export function castFor(bible: ChannelBible | null, lead: string | null, supporting: readonly string[] = []): CastRef[] {
  const slugs = bible ? bible.leadsFromCalendar(lead) : lead ? [lead] : [];
  const all = [...slugs, ...supporting.filter((s) => !slugs.includes(s))];
  return all.map((slug, i) => {
    const c = bible?.characterBySlug(slug);
    return { slug, name: c?.name ?? slug, accent: c?.accent_hex, lead: i === 0 };
  });
}

export interface EpisodeRow {
  id: string;
  slot: string;
  status: string;
  statusDetail: string | null;
  kind: string;
  runId: string | null;
  updatedAt: string;
  estimateInr: number | null;
  premise: string;
  series: string | null;
  lead: string | null;
  supporting: string[];
  scriptId: string | null;
  qc: unknown;
  finalRenderId: string | null;
}

export async function channelEpisodes(db: Db, channelId: string, limit = 300): Promise<EpisodeRow[]> {
  const { data: eps, error } = await db
    .from('episodes')
    .select('id, slot_id, status, status_detail, kind, run_id, updated_at, estimate_inr, brief_id, script_id, qc, final_render_id')
    .eq('channel_id', channelId)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const briefIds = [...new Set((eps ?? []).map((e) => e.brief_id))];
  const briefs = new Map<string, { premise: string; series: string; lead_character: string; supporting_characters: string[] | null }>();
  if (briefIds.length) {
    const { data } = await db.from('briefs').select('id, premise, series, lead_character, supporting_characters').in('id', briefIds);
    for (const b of data ?? []) briefs.set(b.id, b);
  }
  return (eps ?? []).map((e) => {
    const b = briefs.get(e.brief_id);
    return {
      id: e.id,
      slot: e.slot_id ?? 'bank',
      status: e.status,
      statusDetail: e.status_detail,
      kind: e.kind,
      runId: e.run_id,
      updatedAt: e.updated_at,
      estimateInr: e.estimate_inr === null ? null : Number(e.estimate_inr),
      premise: b?.premise ?? '',
      series: b?.series ?? null,
      lead: b?.lead_character ?? null,
      supporting: b?.supporting_characters ?? [],
      scriptId: e.script_id,
      qc: e.qc,
      finalRenderId: e.final_render_id,
    };
  });
}

/** A premise is a sentence; a card wants its title — the part before the dash. */
export function titleOf(premise: string): string {
  const t = premise.split(/\s[—–-]\s/)[0] ?? premise;
  return t.length > 70 ? `${t.slice(0, 67)}…` : t;
}

export interface SlotRow {
  id: string;
  date: string;
  seriesName: string | null;
  series: string | null;
  lead: string | null;
  seasonalTag: string | null;
  topic: string | null;
  kind: string;
}

export async function upcomingSlots(db: Db, channelId: string, fromDate: string, limit = 5): Promise<SlotRow[]> {
  const { data, error } = await db
    .from('slots')
    .select('id, slot_date, series_name, series, lead, seasonal_tag, topic, kind')
    .eq('channel_id', channelId)
    .gte('slot_date', fromDate)
    .order('slot_date')
    .order('id')
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((s) => ({
    id: s.id,
    date: s.slot_date ?? fromDate,
    seriesName: s.series_name,
    series: s.series,
    lead: s.lead,
    seasonalTag: s.seasonal_tag,
    topic: s.topic,
    kind: s.kind,
  }));
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** "18:00:00" on "2026-10-19" in "Asia/Kolkata" → the UTC instant. */
export function zonedInstant(date: string, time: string, tz: string): Date {
  const naive = new Date(`${date}T${time.slice(0, 8).padEnd(8, ':00')}Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(naive);
  const off = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
  const mins = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(naive.getTime() - mins * 60_000);
}

export function tzAbbrev(tz: string): string {
  return tz === 'Asia/Kolkata' ? 'IST' : tz;
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export interface ChannelPolicyRow {
  slotTime: string;
  tz: string;
  kill: boolean;
  killReason: string | null;
  killAt: string | null;
  perShortCap: number | null;
  dailyCap: number | null;
  monthlyCap: number | null;
  longformDayCap: number | null;
  dailyPublishCap: number | null;
}

export async function channelPolicy(db: Db, channelId: string): Promise<ChannelPolicyRow | null> {
  const { data } = await db.from('channel_policy').select('*').eq('channel_id', channelId).maybeSingle();
  if (!data) return null;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    slotTime: data.default_slot_time ?? '18:00:00',
    tz: data.slot_timezone ?? 'Asia/Kolkata',
    kill: !!data.kill_switch,
    killReason: data.kill_switch_reason,
    killAt: data.kill_switch_at,
    perShortCap: n(data.per_short_cap_inr),
    dailyCap: n(data.daily_cap_inr),
    monthlyCap: n(data.monthly_cap_inr),
    longformDayCap: n(data.daily_longform_cap_inr),
    dailyPublishCap: n(data.daily_publish_cap),
  };
}

export interface SpendRow {
  todayInr: number | null;
  monthInr: number | null;
  dailyCap: number | null;
  monthlyCap: number | null;
  perShortCap: number | null;
  longformDayCap: number | null;
}

export async function channelSpend(db: Db, channelId: string): Promise<SpendRow | null> {
  const [{ data }, rows] = await Promise.all([
    db.from('v_channel_spend').select('*').eq('channel_id', channelId).maybeSingle(),
    db.from('cost_ledger').select('id', { count: 'exact', head: true }).eq('channel_id', channelId),
  ]);
  if (!data) return null;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  // v_channel_spend coalesces to 0. A channel whose ledger has never had a row has not spent
  // ₹0 — it has no spend to report — so the figure is withheld (null → em dash on screen).
  const never = !rows.error && rows.count === 0;
  return {
    todayInr: never ? null : n(data.today_inr),
    monthInr: never ? null : n(data.month_inr),
    dailyCap: n(data.daily_cap_inr),
    monthlyCap: n(data.monthly_cap_effective_inr),
    perShortCap: n(data.per_short_cap_inr),
    longformDayCap: n(data.daily_longform_cap_inr),
  };
}

/** Ledger rows for a channel: how many, how many measured. Counts, so `count` is a number. */
export async function ledgerBasis(db: Db, channelId: string): Promise<{ rows: number | null; measured: number | null }> {
  const [all, meas] = await Promise.all([
    db.from('cost_ledger').select('id', { count: 'exact', head: true }).eq('channel_id', channelId),
    db.from('cost_ledger').select('id', { count: 'exact', head: true }).eq('channel_id', channelId).eq('cost_source', 'measured'),
  ]);
  return { rows: all.error ? null : all.count, measured: meas.error ? null : meas.count };
}
