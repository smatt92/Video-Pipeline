import type { Db } from '../db/server';
import { storage } from '../storage';

/**
 * The control plane's read side: everything the MCP tools, the resources and the control
 * room pages show. No writes here.
 *
 * Every aggregate distinguishes "no data" from zero. A median over no snapshots is null, a
 * cost per Short with no finished Short is null, and the gate verdict for a null metric is
 * "unknown" — never a pass and never a fail.
 */

export function parseRange(range: string, now = new Date()): { from: Date; to: Date; label: string } {
  const m = /^(\d{1,3})([hd])$/.exec(range.trim());
  if (!m) throw new Error(`Range "${range}" is not like "1d", "7d", "28d" or "24h".`);
  const ms = Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 86_400_000);
  return { from: new Date(now.getTime() - ms), to: now, label: range };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ── Calendar ─────────────────────────────────────────────────────────────────

export async function calendarUpcoming(db: Db, channelId: string, days: number, today = new Date()) {
  const from = today.toISOString().slice(0, 10);
  const to = new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await db
    .from('v_slot_status')
    .select('id, kind, slot_date, series, series_name, lead, episode, topic, hook, seasonal_tag, topic_status, notes, brief_id, brief_status, flagged, episode_id, episode_status, production_status, publish_at')
    .eq('channel_id', channelId)
    .gte('slot_date', from)
    .lte('slot_date', to)
    .order('slot_date', { ascending: true });
  if (error) throw new Error(error.message);
  const { count: bank } = await db
    .from('slots')
    .select('id', { count: 'exact', head: true })
    .eq('channel_id', channelId)
    .eq('kind', 'bank');
  return { from, to, slots: data ?? [], bank_slots: bank ?? null };
}

// ── Episodes ─────────────────────────────────────────────────────────────────

export async function episodeStatus(db: Db, channelId: string, id: string) {
  const { data: e, error } = await db
    .from('episodes')
    .select('id, brief_id, slot_id, kind, status, status_detail, run_id, script_id, estimate_inr, final_render_id, master_render_id, review_id, publication_id, qc, voice_detail, created_at, updated_at, channel_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!e || e.channel_id !== channelId) return null;

  const [{ data: jobs }, { data: spend }, { data: shots }] = await Promise.all([
    db.from('gen_jobs').select('id, shot_id, render_route, provider, model, status, attempts, reroll_index, last_error, estimate_inr, updated_at').eq('episode_id', id).order('created_at'),
    db.from('v_episode_spend').select('spent_inr, unpriced_rows').eq('episode_id', id).maybeSingle(),
    e.script_id
      ? db.from('shots').select('id, idx, render_route, duration_s, duration_source, status, description').eq('script_id', e.script_id).order('idx')
      : Promise.resolve({ data: [] as never[] }),
  ]);
  let blocker: string | null = null;
  if (e.script_id) {
    const { data: b } = await db.from('v_pipeline_blockers').select('blocker').eq('script_id', e.script_id).maybeSingle();
    blocker = b?.blocker ?? null;
  }
  const { data: policy } = await db.from('channel_policy').select('per_short_cap_inr, daily_longform_cap_inr').eq('channel_id', channelId).single();
  const cap = e.kind === 'long_form' ? num(policy?.daily_longform_cap_inr) : num(policy?.per_short_cap_inr);
  return {
    ...e,
    spend: {
      spent_inr: num(spend?.spent_inr),
      unpriced_rows: num(spend?.unpriced_rows),
      cap_inr: cap,
      basis: 'rate_card estimates unless a row says measured',
    },
    shots: shots ?? [],
    jobs: jobs ?? [],
    blocker,
  };
}

// ── Bundles ──────────────────────────────────────────────────────────────────

export async function readyBundles(db: Db, channelId: string, opts: { withUrls: boolean } = { withUrls: true }) {
  const { data, error } = await db
    .from('v_ready_bundles')
    .select('publication_id, episode_id, slot_id, slot_date, series, topic, platform, status, title, description, tags, made_for_kids, altered_content_disclosed, scheduled_for, marked_scheduled_at, bundle, created_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  if (!opts.withUrls) return rows;
  const driver = storage();
  return Promise.all(
    rows.map(async (r) => {
      const b = (r.bundle ?? {}) as { video_key?: string; files?: Record<string, string> };
      const urls: Record<string, string> = {};
      const keys = { video: b.video_key, ...(b.files ?? {}) };
      for (const [name, key] of Object.entries(keys)) {
        if (!key) continue;
        try {
          urls[name] = (await driver.presignGet({ key, expiresIn: 3600, downloadAs: key.split('/').pop() })).url;
        } catch {
          // A URL that cannot be signed is left out, not faked; the key is still in `bundle`.
        }
      }
      return { ...r, download_urls: urls };
    }),
  );
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export const GATES = { vvsa_pct: 70, apv_pct: 70, subs_per_1k: 1, inr_per_short: 150 } as const;

function gate(value: number | null, line: number, higherIsBetter: boolean): 'pass' | 'fail' | 'unknown' {
  if (value === null) return 'unknown';
  return (higherIsBetter ? value >= line : value <= line) ? 'pass' : 'fail';
}

export async function metricsSummary(db: Db, channelId: string, range: string) {
  const { from, to, label } = parseRange(range);
  const { data: pubs } = await db
    .from('publications')
    .select('id, episode_id, slot_id, title, platform, status, published_at, scheduled_for')
    .eq('channel_id', channelId)
    .in('status', ['scheduled', 'live']);
  const pubIds = (pubs ?? []).map((p) => p.id);
  const { data: snaps } = pubIds.length
    ? await db
        .from('metrics_snapshots')
        .select('publication_id, age_bucket, captured_at, views, engaged_views, avg_view_pct, viewed_vs_swiped_pct, subs_gained, status')
        .in('publication_id', pubIds)
        .gte('captured_at', from.toISOString())
        .order('captured_at', { ascending: false })
    : { data: [] as never[] };

  // Latest measured snapshot per publication within the range.
  const latest = new Map<string, NonNullable<typeof snaps>[number]>();
  for (const s of snaps ?? []) if (s.status === 'measured' && !latest.has(s.publication_id)) latest.set(s.publication_id, s);
  const rows = [...latest.values()];

  const views = rows.reduce<number | null>((n, r) => (r.views === null ? n : (n ?? 0) + Number(r.views)), null);
  const subs = rows.reduce<number | null>((n, r) => (r.subs_gained === null ? n : (n ?? 0) + Number(r.subs_gained)), null);
  const vvsa = median(rows.map((r) => num(r.viewed_vs_swiped_pct)).filter((v): v is number => v !== null).slice(0, 20));
  const apv = median(rows.map((r) => num(r.avg_view_pct)).filter((v): v is number => v !== null));
  const subsPer1k = views && subs !== null ? (subs / views) * 1000 : null;

  const { data: comments } = await db
    .from('comments')
    .select('character_mentions, published_at')
    .eq('channel_id', channelId)
    .gte('published_at', from.toISOString());
  const mentionCounts: Record<string, number> = {};
  for (const c of comments ?? []) for (const s of c.character_mentions ?? []) mentionCounts[s] = (mentionCounts[s] ?? 0) + 1;
  const mentionsTotal = Object.values(mentionCounts).reduce((a, b) => a + b, 0);

  const epIds = (pubs ?? []).map((p) => p.episode_id).filter((x): x is string => !!x);
  const { data: spend } = epIds.length
    ? await db.from('v_episode_spend').select('episode_id, spent_inr, unpriced_rows').in('episode_id', epIds)
    : { data: [] as never[] };
  const priced = (spend ?? []).filter((s) => Number(s.unpriced_rows) === 0);
  const costPerShort = priced.length ? priced.reduce((n, s) => n + Number(s.spent_inr), 0) / priced.length : null;

  const { data: channelSpend } = await db.from('v_channel_spend').select('*').eq('channel_id', channelId).maybeSingle();
  const { data: flags } = await db.from('notifications').select('kind').eq('channel_id', channelId).in('kind', ['policy_flag', 'qc_failed']).gte('created_at', from.toISOString());

  return {
    range: label,
    from: from.toISOString(),
    to: to.toISOString(),
    shorts_measured: rows.length,
    views,
    subs_gained: subs,
    viewed_vs_swiped_median_last20: vvsa,
    apv_median: apv,
    subs_per_1k_views: subsPer1k,
    character_mentions: mentionCounts,
    mentions_per_1k_views: views ? (mentionsTotal / views) * 1000 : null,
    cost_per_short_inr: costPerShort,
    cost_basis: 'rate_card estimates; episodes with any unpriced row are excluded from the average',
    spend: channelSpend,
    policy_or_qc_flags: (flags ?? []).length,
    gates: {
      vvsa: gate(vvsa, GATES.vvsa_pct, true),
      apv: gate(apv, GATES.apv_pct, true),
      subs_per_1k: gate(subsPer1k, GATES.subs_per_1k, true),
      inr_per_short: gate(costPerShort, GATES.inr_per_short, false),
      policy: (flags ?? []).length === 0 ? 'pass' : 'fail',
    },
    note: rows.length === 0 ? 'No measured snapshots in this range — every metric is unknown, not zero.' : undefined,
  };
}

export async function topPerformers(db: Db, channelId: string, n: number) {
  const { data: pubs } = await db
    .from('publications')
    .select('id, episode_id, slot_id, title, platform, published_at')
    .eq('channel_id', channelId)
    .eq('status', 'live');
  const ids = (pubs ?? []).map((p) => p.id);
  if (!ids.length) return { performers: [], note: 'Nothing is live yet.' };
  const { data: snaps } = await db
    .from('metrics_snapshots')
    .select('publication_id, age_bucket, views, avg_view_pct, viewed_vs_swiped_pct, subs_gained, captured_at, status')
    .in('publication_id', ids)
    .eq('status', 'measured')
    .order('captured_at', { ascending: false });
  const latest = new Map<string, NonNullable<typeof snaps>[number]>();
  for (const s of snaps ?? []) if (!latest.has(s.publication_id)) latest.set(s.publication_id, s);
  const epIds = (pubs ?? []).map((p) => p.episode_id).filter((x): x is string => !!x);
  const { data: eps } = epIds.length ? await db.from('episodes').select('id, brief_id').in('id', epIds) : { data: [] as never[] };
  const briefIds = (eps ?? []).map((e) => e.brief_id);
  const { data: briefs } = briefIds.length
    ? await db.from('briefs').select('id, series, lead_character, hook_archetype, structure_variant, premise').in('id', briefIds)
    : { data: [] as never[] };
  return {
    performers: (pubs ?? [])
      .map((p) => {
        const s = latest.get(p.id);
        const ep = (eps ?? []).find((e) => e.id === p.episode_id);
        const br = (briefs ?? []).find((b) => b.id === ep?.brief_id);
        return {
          publication_id: p.id,
          title: p.title,
          slot_id: p.slot_id,
          series: br?.series ?? null,
          lead: br?.lead_character ?? null,
          hook_archetype: br?.hook_archetype ?? null,
          structure_variant: br?.structure_variant ?? null,
          age_bucket: s?.age_bucket ?? null,
          views: num(s?.views),
          apv: num(s?.avg_view_pct),
          viewed_vs_swiped: num(s?.viewed_vs_swiped_pct),
          subs_gained: num(s?.subs_gained),
        };
      })
      .filter((p) => p.apv !== null || p.views !== null)
      .sort((a, b) => (b.apv ?? -1) - (a.apv ?? -1) || (b.views ?? -1) - (a.views ?? -1))
      .slice(0, n),
  };
}

export async function complaintCandidates(db: Db, channelId: string, limit = 20) {
  const { data, error } = await db
    .from('comments')
    .select('id, platform, author_handle, is_public, body, like_count, published_at, complaint_score, character_mentions, used_in_brief_id')
    .eq('channel_id', channelId)
    .eq('is_public', true)
    .is('used_in_brief_id', null)
    .order('complaint_score', { ascending: false })
    .limit(limit * 3);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .filter((c) => num(c.complaint_score) !== null && Number(c.complaint_score) > 0)
    .slice(0, limit)
    .map((c) => ({ ...c, credit_rule: 'Credit by handle only — the comment is public.' }));
}

// ── Costs ────────────────────────────────────────────────────────────────────

export async function costsLedger(db: Db, channelId: string, range: string) {
  const { from, label } = parseRange(range);
  const { data, error } = await db
    .from('v_ledger_effective')
    .select('id, occurred_at, driver, component, unit, cost_inr, cost_source, entry_kind, eff_script_id, eff_channel_id')
    .eq('eff_channel_id', channelId)
    .gte('occurred_at', from.toISOString())
    .order('occurred_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const byComponent: Record<string, { inr: number; unpriced: number; rows: number }> = {};
  for (const r of rows) {
    const k = r.component ?? '(no component)';
    byComponent[k] ??= { inr: 0, unpriced: 0, rows: 0 };
    byComponent[k].rows++;
    if (r.cost_inr === null) byComponent[k].unpriced++;
    else byComponent[k].inr += Number(r.cost_inr);
  }
  const { data: spend } = await db.from('v_channel_spend').select('*').eq('channel_id', channelId).maybeSingle();
  return {
    range: label,
    rows: rows.length,
    total_inr: rows.some((r) => r.cost_inr === null) ? null : rows.reduce((n, r) => n + Number(r.cost_inr), 0),
    priced_total_inr: rows.reduce((n, r) => n + (r.cost_inr === null ? 0 : Number(r.cost_inr)), 0),
    unpriced_rows: rows.filter((r) => r.cost_inr === null).length,
    measured_rows: rows.filter((r) => r.cost_source === 'measured').length,
    by_component: byComponent,
    spend_vs_caps: spend,
    basis: 'rate_card = our price × a quantity; measured = a vendor figure or an observed balance move',
    recent: rows.slice(0, 50),
  };
}
